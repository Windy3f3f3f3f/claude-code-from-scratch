import chalk from "chalk";

export function printWelcome() {
  console.log(
    chalk.bold.cyan("\n  Mini Claude Code") +
      chalk.gray(" — A minimal coding agent\n")
  );
  console.log(chalk.gray("  Type your request, or 'exit' to quit."));
  console.log(chalk.gray("  Commands: /clear /cost /compact /memory /skills\n"));
}

export function printUserPrompt() {
  process.stdout.write(chalk.bold.green("\n> "));
}

export function printAssistantText(text: string) {
  process.stdout.write(text);
}

export function printToolCall(name: string, input: Record<string, any>) {
  const icon = getToolIcon(name);
  const summary = getToolSummary(name, input);
  console.log(chalk.yellow(`\n  ${icon} ${name}`) + chalk.gray(` ${summary}`));
}

export function printToolResult(name: string, result: string) {
  // Edit/write results get special colorized display
  if ((name === "edit_file" || name === "write_file") && !result.startsWith("Error")) {
    printFileChangeResult(name, result);
    return;
  }
  const maxLen = 500;
  const truncated =
    result.length > maxLen
      ? result.slice(0, maxLen) + chalk.gray(`\n  ... (${result.length} chars total)`)
      : result;
  const lines = truncated.split("\n").map((l) => "  " + l);
  console.log(chalk.dim(lines.join("\n")));
}

function printFileChangeResult(name: string, result: string) {
  const lines = result.split("\n");
  // First line is the success message
  console.log(chalk.dim("  " + lines[0]));

  // Rest is content preview or diff
  const maxDisplayLines = 40;
  const contentLines = lines.slice(1);
  const displayLines = contentLines.slice(0, maxDisplayLines);

  for (const line of displayLines) {
    if (!line.trim()) continue;
    if (line.startsWith("@@")) {
      // Diff header
      console.log(chalk.cyan("  " + line));
    } else if (line.startsWith("- ")) {
      // Removed line
      console.log(chalk.red("  " + line));
    } else if (line.startsWith("+ ")) {
      // Added line
      console.log(chalk.green("  " + line));
    } else {
      // File content preview (line numbers)
      console.log(chalk.dim("  " + line));
    }
  }
  if (contentLines.length > maxDisplayLines) {
    console.log(chalk.gray(`  ... (${contentLines.length - maxDisplayLines} more lines)`));
  }
}

export function printError(msg: string) {
  console.error(chalk.red(`\n  Error: ${msg}`));
}

export function printConfirmation(command: string): void {
  console.log(
    chalk.yellow("\n  ⚠ Dangerous command: ") + chalk.white(command)
  );
}

export function printDivider() {
  console.log(chalk.gray("\n  " + "─".repeat(50)));
}

export function printCost(inputTokens: number, outputTokens: number) {
  const costIn = (inputTokens / 1_000_000) * 3;
  const costOut = (outputTokens / 1_000_000) * 15;
  const total = costIn + costOut;
  console.log(
    chalk.gray(
      `\n  Tokens: ${inputTokens} in / ${outputTokens} out (~$${total.toFixed(4)})`
    )
  );
}

export function printRetry(attempt: number, max: number, reason: string) {
  console.log(
    chalk.yellow(`\n  ↻ Retry ${attempt}/${max}: ${reason}`)
  );
}

export function printInfo(msg: string) {
  console.log(chalk.cyan(`\n  ℹ ${msg}`));
}

// ─── Spinner for API calls ──────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

export function startSpinner(label = "Thinking") {
  if (spinnerTimer) return; // already running
  spinnerFrame = 0;
  process.stdout.write(chalk.gray(`\n  ${SPINNER_FRAMES[0]} ${label}...`));
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    // Move cursor to start of line, clear, rewrite
    process.stdout.write(`\r${chalk.gray(`  ${SPINNER_FRAMES[spinnerFrame]} ${label}...`)}`);
  }, 80);
}

export function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    // Clear the spinner line
    process.stdout.write("\r\x1b[K");
  }
}

// ─── Sub-agent display ──────────────────────────────────────

export function printSubAgentStart(type: string, description: string) {
  console.log(
    chalk.magenta(`\n  ┌─ Sub-agent [${type}]: ${description}`)
  );
}

export function printSubAgentEnd(type: string, description: string) {
  console.log(
    chalk.magenta(`  └─ Sub-agent [${type}] completed`)
  );
}

// ─── Tool icons and summaries ───────────────────────────────

function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    read_file: "📖",
    write_file: "✏️",
    edit_file: "🔧",
    list_files: "📁",
    grep_search: "🔍",
    run_shell: "💻",
    skill: "⚡",
    agent: "🤖",
  };
  return icons[name] || "🔨";
}

function getToolSummary(name: string, input: Record<string, any>): string {
  switch (name) {
    case "read_file":
      return input.file_path;
    case "write_file":
      return input.file_path;
    case "edit_file":
      return input.file_path;
    case "list_files":
      return input.pattern;
    case "grep_search":
      return `"${input.pattern}" in ${input.path || "."}`;
    case "run_shell":
      return input.command.length > 60
        ? input.command.slice(0, 60) + "..."
        : input.command;
    case "skill":
      return input.skill_name;
    case "agent":
      return `[${input.type || "general"}] ${input.description || ""}`;
    default:
      return "";
  }
}
