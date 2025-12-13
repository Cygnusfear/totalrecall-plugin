---
name: memory-protocol
description: MANDATORY for all sessions. Use when starting ANY conversation, making decisions, learning something, or ending work. This skill MUST be followed - not optional.
---

<EXTREMELY-IMPORTANT>
Total Recall is MANDATORY. Every session MUST:
1. Review injected context from SessionStart hook
2. Capture decisions and learnings during work with synthesis_create
3. Use synthesis_search via the memory-search agent for lookups

YOU DO NOT HAVE A CHOICE. THIS IS NOT OPTIONAL.
You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

# Total Recall Memory Protocol

**Core principle:** Synthesis-first. Store understanding, not logs.
Context savings: 50-100x through progressive disclosure.

## Session Start (AUTOMATIC)

The SessionStart hook automatically injects recent synthesis context.
You will see `<total_recall_context>` in your system prompt.

**Review this context before starting work:**
- Acknowledge relevant prior decisions: "I see we previously decided X because Y"
- Use `synthesis_unfold(node_id)` if you need more detail on any node
- Use the memory-search agent if you need to find specific context

## During Work (MANDATORY)

### When to Capture - NO EXCEPTIONS

**Made a decision?** MUST use synthesis_create:
```
Announce: "Recording decision: [what you decided]"

mcp__totalrecall__synthesis_create({
  node_type: "decision",
  one_liner: "Chose X over Y because Z",
  summary: "[200 token detailed rationale with key points]",
  full_synthesis: "[Complete context, alternatives considered, implications]",
  session_id: "current-session"
})
```

**Learned something?** MUST use synthesis_create:
```
Announce: "Recording learning: [what you learned]"

mcp__totalrecall__synthesis_create({
  node_type: "learning",
  one_liner: "Discovered X about Y",
  summary: "[Key insight with supporting details]",
  full_synthesis: "[Full context, how discovered, when it applies]",
  session_id: "current-session"
})
```

**Hit a gotcha/bug pattern?** MUST use synthesis_create:
```
Announce: "Recording gotcha: [what to avoid]"

mcp__totalrecall__synthesis_create({
  node_type: "learning",
  one_liner: "Gotcha: X causes Y, avoid by Z",
  summary: "[The problem, symptoms, and fix]",
  full_synthesis: "[Full debugging story, root cause, prevention]",
  session_id: "current-session"
})
```

### What Counts as a Decision

If you're thinking ANY of these, it's a decision - capture it:
- "I'll use X instead of Y"
- "This approach is better because..."
- "Let's structure it this way..."
- "I chose to..."
- "The tradeoff is..."

**Small decisions matter.** They become big problems when forgotten.

## Searching Memory (USE AGENT)

**YOU MUST dispatch the memory-search agent for any memory lookup.**

DO NOT use synthesis_search or synthesis_get_context directly.

```
Task tool:
  description: "Search past synthesis for [topic]"
  prompt: "Find relevant decisions and learnings about [topic]"
  subagent_type: "memory-search"
  model: "haiku"
```

The agent returns compressed synthesis (500 tokens) vs raw data (5000+ tokens).

**Why the agent?**
- 50-100x context savings through synthesis
- Haiku is cheap and fast
- You get actionable insights, not data dumps

## Progressive Disclosure Workflow

1. **SessionStart** injects one-liners (scan cost: ~50 tokens)
2. **Unfold to summary** if you need more (~200 tokens)
3. **Unfold to full** only when you need complete rationale (~500 tokens)
4. **Unfold to raw** only for debugging or verification (~2000+ tokens)

```
synthesis_unfold({
  node_id: "syn_abc123",
  depth: "summary"  // or "full" or "raw"
})
```

## Common Rationalizations That Mean You're About To Fail

If you catch yourself thinking ANY of these, STOP. You are rationalizing.

- "This decision is too small to record"
  → WRONG. Small decisions become big problems. Record it.

- "I'll remember this"
  → WRONG. You won't. The next session won't. Record it.

- "Let me just check the synthesis directly"
  → WRONG. Use the agent. Context is precious.

- "This session is short, no need for protocol"
  → WRONG. Short sessions have decisions too.

- "I'll capture at the end"
  → WRONG. You'll forget details. Capture as you go.

- "The user didn't ask me to track this"
  → WRONG. Memory is infrastructure, not a feature. Record it.

- "This is just a small fix"
  → WRONG. Small fixes often reveal learnings. Record them.

## Direct Tool Access

**OK to use directly:**
- `mcp__totalrecall__synthesis_create` - REQUIRED for capturing
- `mcp__totalrecall__synthesis_unfold` - Fine for drilling into nodes
- `mcp__totalrecall__session_graft` - If hook didn't run

**DISCOURAGED - use agent instead:**
- `mcp__totalrecall__synthesis_search` - Use memory-search agent
- `mcp__totalrecall__synthesis_get_context` - Use memory-search agent

## MCP Tools Reference

| Tool | Use | Context Cost |
|------|-----|--------------|
| synthesis_create | Capture decisions/learnings | ~50 tokens |
| synthesis_unfold | Expand specific node | 50-500 tokens |
| synthesis_search | Find by semantic similarity | 200+ tokens |
| synthesis_get_context | Load session context | 500+ tokens |
| session_graft | Attach to synthesis graph | ~100 tokens |
| synthesis_capture_chunk | Queue for background synthesis | ~20 tokens |
| synthesis_queue_status | Check synthesis pipeline | ~50 tokens |

## Summary

Every session:
1. Review `<total_recall_context>` from hook
2. Capture decisions/learnings with synthesis_create AS YOU WORK
3. Search via memory-search agent, not direct tools
4. Use progressive disclosure: one-liner → summary → full → raw

**Recording is not optional. It is infrastructure.**
