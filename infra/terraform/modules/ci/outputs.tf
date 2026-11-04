output "deploy_role_arn" {
  description = "Set this as the AWS_ROLE_ARN variable on the GitHub environment."
  value       = aws_iam_role.deploy.arn
}
