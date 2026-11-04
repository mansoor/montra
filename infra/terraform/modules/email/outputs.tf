output "domain_identity_arn" {
  description = "SES identity. The SMTP user's policy needs ses:SendRawEmail on it."
  value       = aws_ses_domain_identity.this.arn
}

output "spf_record" {
  description = "SPF record on the MAIL FROM domain."
  value       = local.spf_record
}

output "dmarc_record" {
  description = "DMARC record on the sending domain."
  value       = local.dmarc_record
}

output "dkim_tokens" {
  description = "DKIM tokens. Each has a CNAME under _domainkey."
  value       = aws_ses_domain_dkim.this.dkim_tokens
}

output "smtp_endpoint" {
  description = "SES SMTP host for MAIL_URL."
  value       = "email-smtp.${data.aws_region.current.name}.amazonaws.com"
}
