import os
import sys

from agent import Agent
#step >=4
from session import save_session, load_session
#endstep
#step >=9
from skills import resolve_skill
#endstep


# A tiny REPL: read a line, hand it to the agent, repeat. One-shot mode runs a
# single prompt from argv and exits (handy for scripts and testing). Takes argv
# so it can be driven in-process without spawning a shell.
def main(argv=None) -> None:
    if argv is None:
        argv = sys.argv[1:]
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Set ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL) first.", file=sys.stderr)
        sys.exit(1)

    agent = Agent()
#step >=4
    # --resume: reload the saved conversation before doing anything else.
    resume = "--resume" in argv
    argv = [a for a in argv if a != "--resume"]
    if resume:
        saved = load_session()
        if saved:
            agent.load_history(saved)
            print(f"(resumed {len(saved)} messages)")
#endstep
#step >=10
    # --plan: read-only mode. The agent may read and think, but not write or run shell.
    if "--plan" in argv:
        agent.set_mode("plan")
        argv = [a for a in argv if a != "--plan"]
        print("(plan mode: read-only)")
#endstep

    one_shot = " ".join(argv).strip()
    if one_shot:
#step >=9
        # "/name ..." runs a skill's prompt template; anything else is a message.
        text = resolve_skill(one_shot) or one_shot
#step <=8
        text = one_shot
#endstep
        agent.chat(text)
#step >=4
        save_session(agent.history())
#endstep
        return

    print("mini-claude — type a message, or 'exit' to quit.\n")
    while True:
        try:
            line = input("you: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if line in ("exit", "quit"):
            break
#step >=4
        if line == "/clear":
            agent.clear_history()
            save_session(agent.history())
            print("(history cleared)")
            continue
#endstep
#step >=9
        if line:
            agent.chat(resolve_skill(line) or line)
#step <=8
        if line:
            agent.chat(line)
#endstep
#step >=4
        if line:
            save_session(agent.history())
#endstep


if __name__ == "__main__":
    main()
