output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "service_names" {
  description = "All long-running ECS services."
  value       = keys(local.services)
}

output "repository_urls" {
  description = "ECR repositories by name."
  value       = { for name, repository in aws_ecr_repository.this : name => repository.repository_url }
}

output "repository_arns" {
  description = "ECR repository ARNs."
  value       = [for repository in aws_ecr_repository.this : repository.arn]
}

output "secret_arns" {
  description = "Secrets the owner must fill in, by name."
  value       = { for name, secret in aws_secretsmanager_secret.this : name => secret.arn }
}

output "target_group_arn_suffixes" {
  description = "Target groups for health alarms."
  value = merge(
    { for name, group in aws_lb_target_group.blue : "${name}-blue" => group.arn_suffix },
    { for name, group in aws_lb_target_group.green : "${name}-green" => group.arn_suffix },
    { kratos = aws_lb_target_group.kratos.arn_suffix },
  )
}

output "pass_role_arns" {
  description = "Roles that a task definition registered by the deploy workflow may name."
  value       = concat([aws_iam_role.execution.arn], [for role in aws_iam_role.task : role.arn])
}

output "deploy_config_parameter_arn" {
  description = "SSM parameter read by the deploy workflow."
  value       = aws_ssm_parameter.deploy_config.arn
}

output "deployment_config_arns" {
  description = "CodeDeploy applications and deployment groups the deploy workflow may use."
  value = concat(
    [for app in aws_codedeploy_app.this : "arn:aws:codedeploy:${local.region}:${data.aws_caller_identity.current.account_id}:application:${app.name}"],
    [for app in aws_codedeploy_app.this : "arn:aws:codedeploy:${local.region}:${data.aws_caller_identity.current.account_id}:deploymentgroup:${app.name}/*"],
  )
}

output "ops_key_arn" {
  description = "Key on the repositories, which pushing needs."
  value       = var.ops_key_arn
}
