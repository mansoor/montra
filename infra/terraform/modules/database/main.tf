data "aws_rds_engine_version" "this" {
  engine  = "aurora-postgresql"
  version = var.engine_major_version
  latest  = true
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-aurora-"
  description = "Aurora PostgreSQL"
  vpc_id      = var.vpc_id

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.name}-aurora" }
}

resource "aws_vpc_security_group_ingress_rule" "postgres" {
  for_each = { for index, id in var.allowed_security_group_ids : tostring(index) => id }

  security_group_id            = aws_security_group.this.id
  description                  = "PostgreSQL from application tasks"
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_rds_cluster_parameter_group" "this" {
  name_prefix = "${var.name}-"
  family      = "aurora-postgresql${var.engine_major_version}"
  description = "Montra: TLS required"

  # Clients must use TLS, version 1.2 or later (NFR-01).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "ssl_min_protocol_version"
    value = "TLSv1.2"
  }

  # Statements are logged by duration only, without values, so no financial data reaches the logs.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = var.name
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = data.aws_rds_engine_version.this.version
  database_name      = "montra"

  # The master user only creates the roles in docs/runbooks/first-time-setup.md. RDS keeps its password in Secrets
  # Manager, so it never appears in Terraform state.
  master_username               = "montra_master"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.this.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this.name

  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  # Point-in-time recovery (BAK-01, NFR-08).
  backup_retention_period      = var.backup_retention_days
  preferred_backup_window      = var.preferred_backup_window
  preferred_maintenance_window = var.preferred_maintenance_window
  copy_tags_to_snapshot        = true

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name}-final" : null

  enabled_cloudwatch_logs_exports = ["postgresql"]

  lifecycle {
    # Minor versions upgrade in the maintenance window; the data source would otherwise show them as drift.
    ignore_changes = [engine_version]
  }
}

resource "aws_rds_cluster_instance" "this" {
  count = var.instance_count

  identifier         = "${var.name}-${count.index}"
  cluster_identifier = aws_rds_cluster.this.id
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version
  instance_class     = var.instance_class

  publicly_accessible        = false
  auto_minor_version_upgrade = true
  promotion_tier             = count.index

  performance_insights_enabled    = true
  performance_insights_kms_key_id = var.kms_key_arn

  lifecycle {
    ignore_changes = [engine_version]
  }
}
