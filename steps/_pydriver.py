"""Drive one Python step against the in-process Python mock.

Usage: _pydriver.py <pyStepDir> <scenarioPath> <logPath> <workdir>

Sets up a temp workspace, starts the mock in-thread (same process, so loopback
works everywhere), points the real Anthropic SDK at it via env, imports the
step's Agent, and runs the scenario's prompt. Writes the mock event log for the
test harness to assert on. Prints the agent's stdout (used for demos).
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mock_anthropic import start_mock  # noqa: E402


def main() -> None:
    py_step_dir, scenario_path, log_path, workdir = sys.argv[1:5]
    scenario = json.load(open(scenario_path))

    os.makedirs(workdir, exist_ok=True)
    for name, content in (scenario.get("setup", {}).get("files", {})).items():
        p = os.path.join(workdir, name)
        os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
        with open(p, "w") as f:
            f.write(content)
    os.chdir(workdir)

    url, close = start_mock(scenario, log_path)
    os.environ["ANTHROPIC_BASE_URL"] = url
    os.environ["ANTHROPIC_API_KEY"] = "test"

    sys.path.insert(0, py_step_dir)
    import agent  # the step's agent.py

    agent.Agent().chat(scenario["prompt"])
    close()


if __name__ == "__main__":
    main()
