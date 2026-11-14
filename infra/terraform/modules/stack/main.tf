# Everything one environment needs. The envs/ roots differ only in their inputs, so they can't drift apart.
data "aws_caller_identity" "current" {}
data "cloudflare_ip_ranges" "edge" {}

locals {
  name              = "montra-${var.environment}"
  metrics_namespace = "Montra/${var.environment}"

  hostnames = {
    web  = "app.${var.domain_name}"
    api  = "api.${var.domain_name}"
    auth = "auth.${var.domain_name}"
  }

  # The queues in design 02 §6.
  queues = ["import", "doc", "ai", "schedule", "report", "notify"]
}

module "kms" {
  source = "../kms"

  providers = {
    aws         = aws
    aws.replica = aws.replica
  }

  name              = local.name
  backup_account_id = var.cross_account_backup_enabled ? var.backup_account_id : null
}

module "certificate" {
  source = "../certificate"

  hostnames          = [local.hostnames.web, local.hostnames.api, local.hostnames.auth]
  cloudflare_zone_id = var.cloudflare_zone_id
}

module "network" {
  source = "../network"

  name                    = local.name
  vpc_cidr                = var.vpc_cidr
  availability_zone_count = var.availability_zone_count
  single_nat_gateway      = var.single_nat_gateway
  certificate_arn         = module.certificate.certificate_arn
  alb_ingress_cidrs       = data.cloudflare_ip_ranges.edge.ipv4_cidr_blocks
  deletion_protection     = var.protect_from_deletion
}

module "database" {
  source = "../database"

  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.database_subnet_ids
  allowed_security_group_ids = [module.network.app_security_group_id]
  kms_key_arn                = module.kms.database_key_arn
  instance_class             = var.db_instance_class
  instance_count             = var.db_instance_count
  backup_retention_days      = var.db_backup_retention_days
  deletion_protection        = var.protect_from_deletion
}

module "storage" {
  source = "../storage"

  providers = {
    aws         = aws
    aws.replica = aws.replica
  }

  name                = local.name
  bucket_name         = "${var.bucket_prefix}-${var.environment}-files"
  replica_bucket_name = "${var.bucket_prefix}-${var.environment}-files-replica"
  kms_key_arn         = module.kms.storage_key_arn
  replica_kms_key_arn = module.kms.storage_replica_key_arn
  force_destroy       = !var.protect_from_deletion
}

module "backup" {
  source = "../backup"

  providers = {
    aws                = aws
    aws.replica        = aws.replica
    aws.backup_account = aws.backup_account
  }

  name                           = local.name
  resource_arns                  = [module.database.cluster_arn]
  kms_key_arn                    = module.kms.database_key_arn
  replica_kms_key_arn            = module.kms.database_replica_key_arn
  cross_account_copy_enabled     = var.cross_account_backup_enabled
  source_account_id              = data.aws_caller_identity.current.account_id
  vault_lock_enabled             = var.vault_lock_enabled
  vault_lock_changeable_for_days = var.vault_lock_changeable_for_days
}

module "email" {
  source = "../email"

  domain_name          = var.domain_name
  cloudflare_zone_id   = var.cloudflare_zone_id
  dmarc_policy         = var.dmarc_policy
  dmarc_report_address = var.dmarc_report_address
}

module "compute" {
  source = "../compute"

  name                  = local.name
  environment           = var.environment
  vpc_id                = module.network.vpc_id
  private_subnet_ids    = module.network.private_subnet_ids
  app_security_group_id = module.network.app_security_group_id
  https_listener_arn    = module.network.https_listener_arn
  test_listener_arn     = module.network.test_listener_arn
  hostnames             = local.hostnames
  cookie_domain         = var.domain_name
  image_tag             = var.image_tag

  s3_bucket_name  = module.storage.bucket_name
  s3_bucket_arn   = module.storage.bucket_arn
  storage_key_arn = module.kms.storage_key_arn
  data_key_arn    = module.kms.data_key_arn
  ops_key_arn     = module.kms.ops_key_arn

  secret_recovery_window_days = var.protect_from_deletion ? 30 : 0

  mail_from           = "Montra <no-reply@${var.domain_name}>"
  kratos_from_address = "no-reply@${var.domain_name}"
  support_email       = var.support_email

  billing_mode      = var.billing_mode
  extra_environment = var.extra_environment

  services               = var.services
  metrics_namespace      = local.metrics_namespace
  deployment_config_name = var.deployment_config_name

  # By name, not by reference: the observability module needs this module's outputs, so a reference would be a cycle.
  rollback_alarm_names = ["${local.name}-5xx-rate"]
}

module "edge" {
  source = "../edge"

  cloudflare_zone_id  = var.cloudflare_zone_id
  origin_hostname     = module.network.alb_dns_name
  hostnames           = local.hostnames
  managed_waf_enabled = var.managed_waf_enabled

  rate_limit_period_seconds = var.rate_limit_period_seconds
  count_failures_only       = var.rate_limit_count_failures_only
}

module "observability" {
  source = "../observability"

  name                      = local.name
  kms_key_arn               = module.kms.ops_key_arn
  alarm_emails              = var.alarm_emails
  metrics_namespace         = local.metrics_namespace
  queues                    = local.queues
  alb_arn_suffix            = module.network.alb_arn_suffix
  target_group_arn_suffixes = module.compute.target_group_arn_suffixes
  ecs_cluster_name          = module.compute.cluster_name
  aurora_cluster_identifier = module.database.cluster_identifier

  ecs_services = {
    api            = var.services.api.min
    worker         = var.services.worker.min
    web            = var.services.web.min
    doc-worker     = var.services.doc_worker.desired
    kratos         = var.services.kratos.desired
    kratos-courier = 1
  }
}

module "ci" {
  source = "../ci"

  name                        = local.name
  environment                 = var.environment
  github_repository           = var.github_repository
  create_oidc_provider        = var.create_github_oidc_provider
  ecs_cluster_name            = module.compute.cluster_name
  repository_arns             = module.compute.repository_arns
  ecr_kms_key_arn             = module.compute.ops_key_arn
  pass_role_arns              = module.compute.pass_role_arns
  deploy_config_parameter_arn = module.compute.deploy_config_parameter_arn
  codedeploy_arns             = module.compute.deployment_config_arns
}
