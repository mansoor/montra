data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_root = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"

  # Multi-region keys, each with a replica in the second region, so that a restore in that region can read what the
  # key protects (BAK-02):
  #   data:     wraps the per-workspace data keys behind the `_enc` columns (NFR-01). Without it in the second
  #             region a restored database is unreadable.
  #   database: Aurora storage, snapshots and Performance Insights.
  #   storage:  S3 objects. The replica encrypts the replicated bucket.
  multi_region_keys = {
    data     = "Field-level envelope encryption"
    database = "Aurora storage and backups"
    storage  = "S3 files"
  }
}

data "aws_iam_policy_document" "multi_region" {
  for_each = local.multi_region_keys

  statement {
    sid       = "AccountAdministers"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }

  dynamic "statement" {
    for_each = each.key == "database" && var.backup_account_id != null ? [var.backup_account_id] : []

    content {
      sid = "BackupAccountCopiesAndRestores"
      actions = [
        "kms:CreateGrant",
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:GenerateDataKey*",
        "kms:ReEncrypt*",
      ]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = ["arn:${data.aws_partition.current.partition}:iam::${statement.value}:root"]
      }
    }
  }
}

resource "aws_kms_key" "multi_region" {
  for_each = local.multi_region_keys

  description             = "${var.name}: ${each.value}"
  multi_region            = true
  enable_key_rotation     = true
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.multi_region[each.key].json
}

resource "aws_kms_alias" "multi_region" {
  for_each = local.multi_region_keys

  name          = "alias/${var.name}-${each.key}"
  target_key_id = aws_kms_key.multi_region[each.key].key_id
}

resource "aws_kms_replica_key" "multi_region" {
  for_each = local.multi_region_keys

  provider = aws.replica

  description             = "${var.name}: ${each.value} (replica)"
  primary_key_arn         = aws_kms_key.multi_region[each.key].arn
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.multi_region[each.key].json
}

resource "aws_kms_alias" "replica" {
  for_each = local.multi_region_keys

  provider = aws.replica

  name          = "alias/${var.name}-${each.key}"
  target_key_id = aws_kms_replica_key.multi_region[each.key].key_id
}

# Single-region key for Secrets Manager and the alarm topic. CloudWatch can't publish to a topic encrypted with an
# AWS-managed key, so the alarm services are named here.
data "aws_iam_policy_document" "ops" {
  statement {
    sid       = "AccountAdministers"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }

  statement {
    sid       = "AlarmServicesPublishToTheTopic"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com", "cloudwatch.amazonaws.com", "events.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "ops" {
  description             = "${var.name}: secrets and alarm notifications"
  enable_key_rotation     = true
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.ops.json
}

resource "aws_kms_alias" "ops" {
  name          = "alias/${var.name}-ops"
  target_key_id = aws_kms_key.ops.key_id
}
