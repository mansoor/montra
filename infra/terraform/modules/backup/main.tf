locals {
  # Upper bound for the lock: the longest retention plus room to change the schedule within it.
  lock_max_retention_days = var.monthly_retention_days + 30
}

resource "aws_backup_vault" "primary" {
  name        = var.name
  kms_key_arn = var.kms_key_arn
}

resource "aws_backup_vault" "replica" {
  provider = aws.replica

  name        = "${var.name}-replica"
  kms_key_arn = var.replica_kms_key_arn
}

# The backup account's own key, so a compromise of the production account can't touch these copies.
resource "aws_kms_key" "cross_account" {
  count = var.cross_account_copy_enabled ? 1 : 0

  provider = aws.backup_account

  description             = "${var.name}: backup copies from the production account"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_backup_vault" "cross_account" {
  count = var.cross_account_copy_enabled ? 1 : 0

  provider = aws.backup_account

  name        = "${var.name}-copies"
  kms_key_arn = aws_kms_key.cross_account[0].arn
}

data "aws_iam_policy_document" "cross_account_vault" {
  count = var.cross_account_copy_enabled ? 1 : 0

  statement {
    sid       = "SourceAccountCopiesIn"
    actions   = ["backup:CopyIntoBackupVault"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.source_account_id}:root"]
    }
  }
}

resource "aws_backup_vault_policy" "cross_account" {
  count = var.cross_account_copy_enabled ? 1 : 0

  provider = aws.backup_account

  backup_vault_name = aws_backup_vault.cross_account[0].name
  policy            = data.aws_iam_policy_document.cross_account_vault[0].json
}

resource "aws_backup_vault_lock_configuration" "primary" {
  count = var.vault_lock_enabled ? 1 : 0

  backup_vault_name   = aws_backup_vault.primary.name
  changeable_for_days = var.vault_lock_changeable_for_days
  min_retention_days  = var.daily_retention_days
  max_retention_days  = local.lock_max_retention_days
}

resource "aws_backup_vault_lock_configuration" "replica" {
  count = var.vault_lock_enabled ? 1 : 0

  provider = aws.replica

  backup_vault_name   = aws_backup_vault.replica.name
  changeable_for_days = var.vault_lock_changeable_for_days
  min_retention_days  = var.daily_retention_days
  max_retention_days  = local.lock_max_retention_days
}

resource "aws_backup_vault_lock_configuration" "cross_account" {
  count = var.vault_lock_enabled && var.cross_account_copy_enabled ? 1 : 0

  provider = aws.backup_account

  backup_vault_name   = aws_backup_vault.cross_account[0].name
  changeable_for_days = var.vault_lock_changeable_for_days
  min_retention_days  = var.daily_retention_days
  max_retention_days  = local.lock_max_retention_days
}

resource "aws_backup_plan" "this" {
  name = var.name

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = var.daily_schedule
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = var.daily_retention_days
    }

    # A single Aurora copy can't change both region and account, so each destination gets its own copy action: the
    # second region in this account, and the backup account in this region.
    copy_action {
      destination_vault_arn = aws_backup_vault.replica.arn

      lifecycle {
        delete_after = var.daily_retention_days
      }
    }

    dynamic "copy_action" {
      for_each = var.cross_account_copy_enabled ? [aws_backup_vault.cross_account[0].arn] : []

      content {
        destination_vault_arn = copy_action.value

        lifecycle {
          delete_after = var.daily_retention_days
        }
      }
    }
  }

  rule {
    rule_name         = "monthly"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = var.monthly_schedule
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = var.monthly_retention_days
    }

    copy_action {
      destination_vault_arn = aws_backup_vault.replica.arn

      lifecycle {
        delete_after = var.monthly_retention_days
      }
    }

    dynamic "copy_action" {
      for_each = var.cross_account_copy_enabled ? [aws_backup_vault.cross_account[0].arn] : []

      content {
        destination_vault_arn = copy_action.value

        lifecycle {
          delete_after = var.monthly_retention_days
        }
      }
    }
  }
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_selection" "this" {
  name         = var.name
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = var.resource_arns
}
