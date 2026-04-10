
<!-- cortex-managed -->
## Cortex Agent Protocol

### Mandatory Workflow
1. Check for available tasks via Cortex MCP tools before starting work
2. Decide whether to claim an existing matching task or create a new one before ANY code changes
3. Report progress at least twice during execution
4. Run tests before submitting
5. Submit result through Cortex
6. Request verification and handle feedback

### Constraints
- ALL files MUST be created inside the workspace
- NEVER produce stub implementations
- NEVER fake test results
- Never push to git without explicit task instruction
- NEVER grant permissions to others/everyone
- For numeric chmod, modes MUST end in 0
<!-- /cortex-managed -->


