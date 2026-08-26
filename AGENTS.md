# Environment credentials

- Before any Google API, authentication, or integration-test check, load the project `.env` so `GOOGLE_APPLICATION_CREDENTIALS` is available.
- Do not diagnose Google credential scopes from fallback Application Default Credentials unless `.env` has been loaded first.

# Testing

- Use fast JavaScript unit tests first for iteration. Assert ProseMirror step translation and exact Google Docs request payloads.
- After unit tests pass, run focused Selenium integration tests to validate browser, sync queue, backend, and real Google Docs behavior.
- Run Selenium outside the sandbox.
- Run full regression suite before completing a phase.
