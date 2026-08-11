import sys
import unittest
from pathlib import Path

_PYTHON_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PYTHON_DIR))

try:
    from mini_claude.agent import Agent
    from mini_claude.ui import get_cache_write_rate, get_model_pricing
    HAVE_DEPS = True
except Exception:
    HAVE_DEPS = False


@unittest.skipUnless(HAVE_DEPS, "anthropic/openai/rich not installed")
class TestModelParameters(unittest.TestCase):
    def test_minimax_parameters(self):
        m3_pricing = get_model_pricing("MiniMax-M3")
        self.assertEqual(m3_pricing, {
            "input": 0.6,
            "output": 2.4,
            "cache_read": 0.12,
            "cache_write": None,
        })
        self.assertEqual(get_cache_write_rate(m3_pricing), 0.6)
        self.assertEqual(get_model_pricing("MiniMax-M2.7"), {
            "input": 0.3,
            "output": 1.2,
            "cache_read": 0.06,
            "cache_write": 0.375,
        })

        m3 = Agent(api_key="test-key", model="MiniMax-M3", thinking=True)
        self.assertEqual(m3.effective_window, 980000)
        self.assertEqual(m3._thinking_mode, "adaptive")
        m3.total_input_tokens = 1_000_000
        m3.total_output_tokens = 1_000_000
        m3.total_cache_read_tokens = 1_000_000
        m3.total_cache_creation_tokens = 1_000_000
        self.assertAlmostEqual(m3._get_current_cost_usd(), 3.72)

        m3_disabled = Agent(api_key="test-key", model="MiniMax-M3")
        self.assertEqual(m3_disabled._thinking_mode, "disabled")

        m27 = Agent(api_key="test-key", model="MiniMax-M2.7")
        self.assertEqual(m27.effective_window, 184800)
        self.assertEqual(m27._thinking_mode, "enabled")
        m27.total_input_tokens = 1_000_000
        m27.total_output_tokens = 1_000_000
        m27.total_cache_read_tokens = 1_000_000
        m27.total_cache_creation_tokens = 1_000_000
        self.assertAlmostEqual(m27._get_current_cost_usd(), 1.935)


if __name__ == "__main__":
    unittest.main(verbosity=2)
