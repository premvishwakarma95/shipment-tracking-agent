import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Most other env vars are read inline in the file that needs them (matches
// the reference project's convention) — this only centralizes the handful
// that are used from more than one place.
export const env = {
  vapiApiKey: required("VAPI_API_KEY"),
  vapiAssistantId: required("VAPI_ASSISTANT_ID"),
  vapiPhoneNumberId: required("VAPI_PHONE_NUMBER_ID"),
  publicBaseUrl: required("PUBLIC_BASE_URL"),
};
