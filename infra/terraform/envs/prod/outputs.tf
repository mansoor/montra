output "deploy_role_arn" {
  description = "Set as the AWS_ROLE_ARN variable on the GitHub environment."
  value       = module.stack.deploy_role_arn
}

output "hostnames" {
  description = "Public hostnames."
  value       = module.stack.hostnames
}

output "aurora_writer_endpoint" {
  description = "Host for every connection string."
  value       = module.stack.aurora_writer_endpoint
}

output "aurora_reader_endpoint" {
  description = "Host for reporting connections."
  value       = module.stack.aurora_reader_endpoint
}

output "aurora_master_secret_arn" {
  description = "Secret with the master password, used once to create the roles."
  value       = module.stack.aurora_master_secret_arn
}

output "secret_arns" {
  description = "Secrets to fill in by hand before the services can start."
  value       = module.stack.secret_arns
}

output "repository_urls" {
  description = "ECR repositories by name."
  value       = module.stack.repository_urls
}

output "alarm_topic_arn" {
  description = "SNS topic with every alarm. Connect it to your pager."
  value       = module.stack.alarm_topic_arn
}

output "ses_smtp_endpoint" {
  description = "SES SMTP host for MAIL_URL and KRATOS_SMTP_URL."
  value       = module.stack.ses_smtp_endpoint
}

output "ses_identity_arn" {
  description = "SES identity for the SMTP user's policy."
  value       = module.stack.ses_identity_arn
}

output "spf_record" {
  description = "SPF record, created in Cloudflare."
  value       = module.stack.spf_record
}

output "dmarc_record" {
  description = "DMARC record, created in Cloudflare."
  value       = module.stack.dmarc_record
}
