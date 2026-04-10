# Cortex Architecture

Cortex is a local-first AI agent gateway designed around a strict structural frame.

- **Frontend (Platform)**: A React dashboard strictly partitioned into pure UI components and distinct API/Mock data layers.
- **Backend (Platform)**: An Express app that manages the Dashboard's UI delivery and routes minimal proxy requests.
- **Gateway (Service)**: The LLM proxy and actual agent orchestrator running on port 4840. Handles tasks, rules, and telemetry.
- **Workspace Data**: Runtime state lives in `~/CortexHub/data`. Projects are actively logged in `~/CortexHub/projects`.
