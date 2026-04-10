export function getNextStepHint(toolName, args = {}, result = null) {
  switch (toolName) {
    case 'health_check':
      return 'Check your state, then task_list or get_next_task.';
    case 'agent_status':
      return 'Review your current state, then inspect active tasks or claim new work.';
    case 'task_create':
      return 'Creates the task in the DB and the folder on disk. Now claim it.';
    case 'task_get':
      return 'Inspect the task details, then decide the correct lifecycle action.';
    case 'task_list':
      return args.status === 'review'
        ? 'Pick up tasks in review status where you are the reviewer.'
        : 'Use task_get for full detail or claim a matching pending task.';
    case 'get_next_task':
      return result?.status === 'review'
        ? 'Pick up tasks in review status where you are the reviewer.'
        : 'Claim it if it matches your work, or task_create if nothing fits.';
    case 'claim_task':
      return 'Report planning progress before writing any code.';
    case 'report_progress':
      if (args.status === 'planning') return 'Begin implementation.';
      if (args.status === 'implementation' || args.status === 'in_progress') return 'Must include files_changed. Report at least once more before submitting.';
      if (args.status === 'testing') return 'Run tests, report results, then submit_result.';
      if (args.status === 'reviewing') return 'Document your findings.';
      return 'Continue work and report progress again before submitting.';
    case 'submit_result':
      return 'Blocked if stubs detected or no real file changes.';
    case 'request_verification':
      return 'Specify reviewer agent. Cannot be yourself.';
    case 'task_approve':
      return 'Cannot review your own work.';
    case 'task_reject':
      return 'Cannot review your own work. If rejected, include feedback.';
    case 'task_update':
      return 'Task metadata updated.';
    case 'task_cancel':
      return 'Task cancelled. Choose another task or create a replacement if needed.';
    case 'task_release':
      return 'Task released. Any agent can now claim it.';
    case 'task_reassign':
      return 'Task reassigned as pending. The target agent can now claim it.';
    case 'task_comment':
      return 'Comment added. Continue work or inspect the task again.';
    case 'task_reopen':
      return 'Task reopened as pending. Claim it to continue work.';
    case 'bridge_send':
      return 'Notify the reviewer that work is ready for audit.';
    case 'bridge_reply':
      return 'Reply sent.';
    case 'bridge_inbox':
      return 'Review the messages and respond or act on any requests.';
    case 'heartbeat':
      return 'Heartbeat recorded. Continue work.';
    case 'agent_register':
      return 'Save the returned token immediately and configure the new agent to use it.';
    default:
      return '';
  }
}
