export const CORTEX_PROMPTS = [
  {
    name: 'review_cycle',
    description: 'Start a code review cycle between two agents. Guides through: submit for review, wait for response, apply changes, verify.',
    arguments: [
      { name: 'reviewer', description: 'Agent name to review the code', required: true },
      { name: 'files', description: 'Comma-separated file paths to review', required: true },
    ],
  },
  {
    name: 'morning_briefing',
    description: 'Generate a morning briefing: overnight agent activity, pending tasks, system health, cost summary.',
    arguments: [],
  },
  {
    name: 'deploy_check',
    description: 'Pre-deployment checklist: run tests, verify endpoints, check error rates, confirm with user.',
    arguments: [
      { name: 'branch', description: 'Branch to deploy from', required: false },
    ],
  },
];

export function getPrompt(name, args = {}) {
  switch (name) {
    case 'review_cycle':
      return {
        description: 'Code review cycle workflow',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Start a code review cycle.\n\nReviewer: ${args.reviewer || '(not specified)'}\nFiles: ${args.files || '(none specified)'}\n\nSteps:\n1. Use bridge_send to submit files for review (type: "review_request")\n2. Use bridge_inbox to check for the response\n3. Apply any feedback\n4. Use bridge_send to confirm completion (type: "review_response")\n\nBegin by sending the review request now.`,
            },
          },
        ],
      };

    case 'morning_briefing':
      return {
        description: 'Morning briefing workflow',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Generate a morning briefing by running these tools in order:\n1. health_check -- confirm all services are up\n2. agent_status -- check all agent states\n3. task_list -- review pending and active tasks\n4. bridge_inbox for each agent -- surface any overnight messages\n\nSummarise findings in a concise briefing: service status, what each agent is working on, any blockers.`,
            },
          },
        ],
      };

    case 'deploy_check':
      return {
        description: 'Pre-deployment checklist',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Run the pre-deployment checklist${args.branch ? ` for branch: ${args.branch}` : ''}.\n\n1. health_check -- all services must be up\n2. task_list status=active -- no critical tasks should be in-flight\n3. agent_status -- confirm agents are idle and available\n4. Confirm with the user before proceeding\n\nReport any blockers before giving the all-clear.`,
            },
          },
        ],
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
