// The body Kratos posts to Twilio for each text (ADR-0049 §6), form-encoded because the channel sets that
// Content-Type. The Messaging Service id is set per deployment; base64 this file into `request_config.body`.
function(ctx) {
  To: ctx.recipient,
  Body: ctx.body,
  MessagingServiceSid: "MG00000000000000000000000000000000",
}
