# Repositories monitored by Hermes

42 repositories verified through the GitHub repository API on 2026-10-08.

| Group | Repository | Why monitor |
|---|---|---|
| own | [louisphamdev/intact](https://github.com/louisphamdev/intact) | Deployment and local converter changes |
| own | [louisphamdev/llm-switcher](https://github.com/louisphamdev/llm-switcher) | Deployment and local converter changes |
| own | [louisphamdev/zencore](https://github.com/louisphamdev/zencore) | Deployment and local converter changes |
| client | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | Client wire contract, configuration, context and transport changes |
| client | [anomalyco/opencode](https://github.com/anomalyco/opencode) | Client wire contract, configuration, context and transport changes |
| client | [anthropics/claude-code](https://github.com/anthropics/claude-code) | Client wire contract, configuration, context and transport changes |
| client | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | Client wire contract, configuration, context and transport changes |
| client | [openai/codex](https://github.com/openai/codex) | Client wire contract, configuration, context and transport changes |
| peer | [1rgs/claude-code-proxy](https://github.com/1rgs/claude-code-proxy) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [BerriAI/litellm](https://github.com/BerriAI/litellm) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [SaladDay/cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [The-NeXT-AI/ai-gateway](https://github.com/The-NeXT-AI/ai-gateway) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [decolua/9router](https://github.com/decolua/9router) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [maximhq/bifrost](https://github.com/maximhq/bifrost) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | Comparable gateway conversion, routing, compaction and failover fixes |
| peer | [songquanpeng/one-api](https://github.com/songquanpeng/one-api) | Comparable gateway conversion, routing, compaction and failover fixes |
| runtime | [Kludex/starlette](https://github.com/Kludex/starlette) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [anomalyco/models.dev](https://github.com/anomalyco/models.dev) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [anthropics/anthropic-sdk-python](https://github.com/anthropics/anthropic-sdk-python) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [googleapis/js-genai](https://github.com/googleapis/js-genai) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [googleapis/python-genai](https://github.com/googleapis/python-genai) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [openai/openai-node](https://github.com/openai/openai-node) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [openai/openai-openapi](https://github.com/openai/openai-openapi) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [openai/openai-python](https://github.com/openai/openai-python) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| protocol-sdk | [vercel/ai](https://github.com/vercel/ai) | Authoritative protocol schemas, SDK serialization and tool compatibility |
| compression | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | History and tool-output transformations before gateway forwarding |
| compression | [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) | History and tool-output transformations before gateway forwarding |
| compression | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) | History and tool-output transformations before gateway forwarding |
| compression | [yamadashy/repomix](https://github.com/yamadashy/repomix) | History and tool-output transformations before gateway forwarding |
| runtime | [encode/httpx](https://github.com/encode/httpx) | ZenCore HTTP streaming, validation and transport dependencies |
| runtime | [fastapi/fastapi](https://github.com/fastapi/fastapi) | ZenCore HTTP streaming, validation and transport dependencies |
| runtime | [pydantic/pydantic](https://github.com/pydantic/pydantic) | ZenCore HTTP streaming, validation and transport dependencies |
| runtime | [python-jsonschema/jsonschema](https://github.com/python-jsonschema/jsonschema) | ZenCore HTTP streaming, validation and transport dependencies |

## Discovery boundary

Weekly, discover new protocol-compatible gateways and active forks from peer READMEs, dependencies and linked issues. Verify canonical origin before proposing additions. Do not add unrelated popular repositories.

## Known signals

CC Switch PR #5536 is open and unmerged; its implementation is evidence for an approach, not a released fix. OmniRoute PR #15421 describes optional deterministic trimming, not Codex remote compaction. 9Router issue #3816 reports a rejected model-ending compaction request.

## Existing-session migration

New gateway summaries use a versioned capsule. Native OpenAI ciphertext passes through only on native Responses routes. Unknown/native/legacy compaction items are rejected on converted routes instead of silently losing history. Legacy unmarked prose requires explicit recovery through its original transcript; do not treat arbitrary ciphertext as a summary.

## Verification baseline

Local installed clients at investigation time: Codex 0.160.1, Claude Code 2.1.293. Treat these as a recorded baseline, not current release pins.
