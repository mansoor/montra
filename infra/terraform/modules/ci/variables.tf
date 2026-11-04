variable "name" {
  description = "Prefix for resource names, for example montra-prod."
  type        = string
}

variable "environment" {
  description = "GitHub environment allowed to assume the deploy role: dev, staging or prod."
  type        = string
}

variable "github_repository" {
  description = "Repository allowed to deploy, as owner/name."
  type        = string
}

variable "create_oidc_provider" {
  description = "Create the GitHub OIDC provider. An AWS account can hold only one, so set false in every environment after the first if they share an account."
  type        = bool
  default     = true
}

variable "ecs_cluster_name" {
  description = "ECS cluster the role deploys to."
  type        = string
}

variable "repository_arns" {
  description = "ECR repositories the role pushes to."
  type        = list(string)
}

variable "ecr_kms_key_arn" {
  description = "Key on the ECR repositories."
  type        = string
}

variable "pass_role_arns" {
  description = "Roles that task definitions registered by the workflow may name."
  type        = list(string)
}

variable "deploy_config_parameter_arn" {
  description = "SSM parameter with the deploy settings."
  type        = string
}

variable "codedeploy_arns" {
  description = "CodeDeploy applications and deployment groups the role may use."
  type        = list(string)
}
