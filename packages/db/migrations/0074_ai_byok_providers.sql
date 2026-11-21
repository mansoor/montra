-- Your own key with OpenAI, Google Gemini and Azure OpenAI (UP-13, backlog item 3). Their keys are kept like
-- Anthropic's; widening the check only lets more providers in.
alter table app.ai_credential drop constraint ai_credential_provider_check;
alter table app.ai_credential add constraint ai_credential_provider_check
  check (provider in ('anthropic', 'openai', 'gemini', 'azure_openai', 'openai_compatible'));
