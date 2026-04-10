# Task Lifecycle

Cortex uses a strict task state machine so agent work has a durable workflow.

## Standard flow

1. `pending`
2. `claimed`
3. `in_progress`
4. `submitted`
5. `review`
6. `approved` or `rejected`

## Expected behavior

1. An agent claims a task.
2. The agent reports progress while working.
3. The agent submits a result.
4. A reviewer checks the work.
5. The task is approved or sent back.

## Why this exists

Without task state, agents can skip straight to "done" with no durable record of what actually happened.

The Cortex task flow forces work into visible steps:

- who picked it up
- whether progress was reported
- when it was submitted
- who reviewed it
- what the final verdict was

## Supporting records

Cortex can attach extra activity to the task lifecycle:

- progress reports
- comments
- audit trail entries
- bridge handoffs
- sub-agent work
- runtime logs

## Review model

Review is a first-class state, not an afterthought. That keeps "agent says it is finished" separate from "someone verified it."
