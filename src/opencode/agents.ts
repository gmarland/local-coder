import type { Recommendation, Role } from "../types.js";

const prompts: Record<Role, { description: string; body: string }> = {
  orchestrator: { description: "Primary coordinator that delegates repository changes, research, and review to specialist agents", body: "Understand the request, form a concise plan, and coordinate the result. Delegate every repository modification or debugging task to @coder, unfamiliar domain or evidence gathering to @researcher, and independent review of significant changes to @reviewer. Every delegation prompt must be self-contained: include the user's concrete request, relevant paths and constraints, and the expected outcome. You may answer simple questions directly, but do not edit files or run implementation commands yourself. Present one coherent final result." },
  coder: { description: "Implements, debugs, refactors, and tests repository changes; use for hands-on software engineering", body: "Explore the repository efficiently, follow its conventions, and inspect every relevant existing file before changing it. Implement the complete request from the orchestrator; never replace real project content with generic placeholders. Run proportionate tests, builds, linters, and type checks. Prefer targeted searches. Do not invent requirements; report missing context to the orchestrator." },
  researcher: { description: "Researches unfamiliar concepts, documents, requirements, and domain evidence before implementation", body: "Investigate domain questions and requirements, distinguish evidence from inference, and return concise findings with sources when available. Never invent domain requirements. Do not modify application code unless explicitly instructed." },
  reviewer: { description: "Independently reviews significant changes for correctness, regressions, security, assumptions, and test coverage", body: "Review the implementation independently. Prioritise concrete correctness bugs, missed requirements, regressions, security risks, unsafe assumptions, and inadequate tests. Cite files and lines where possible. Do not edit files; report findings and residual risks." }
};
export function generateAgent(role: Role, recommendation: Recommendation): string {
  const primary = role === "orchestrator";
  const permission = primary ? "  task:\n    \"*\": deny\n    coder: allow\n    researcher: allow\n    reviewer: allow\n  edit: deny\n  bash: deny"
    : role === "researcher" || role === "reviewer" ? "  edit: deny\n  bash: deny" : "  task: deny";
  return `---\ndescription: ${prompts[role].description}\nmode: ${primary ? "primary" : "subagent"}\nmodel: ollama/${recommendation.assignments[role].ollamaModel}\npermission:\n${permission}\n---\n\n${prompts[role].body}\n`;
}
export const generalInstructions = `# Local coding agent guidance

- Prefer specialist agents when their expertise is useful, but do not delegate unnecessarily.
- Research unfamiliar domain concepts before implementing them; never invent domain requirements.
- Follow repository conventions and prefer targeted searches over reading large numbers of files.
- Run appropriate tests after implementation.
- Review significant changes before completion.
- Keep prompts, source code, and machine information local unless the user explicitly configures an external service.
`;
