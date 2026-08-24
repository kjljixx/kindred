# Environment credentials

- Before any Google API, authentication, or integration-test check, load the project `.env` so `GOOGLE_APPLICATION_CREDENTIALS` is available.
- Do not diagnose Google credential scopes from fallback Application Default Credentials unless `.env` has been loaded first.
