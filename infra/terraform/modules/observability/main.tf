data "aws_caller_identity" "current" {}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = var.kms_key_arn
}

data "aws_iam_policy_document" "alarms_topic" {
  statement {
    sid       = "AccountManages"
    actions   = ["sns:*"]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "ServicesPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com", "cloudwatch.amazonaws.com", "events.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alarm_emails)

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
}

# ----- API availability -------------------------------------------------------------------------------------------

# Rollbacks in the compute module refer to this alarm by name.
resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  alarm_name          = "${var.name}-5xx-rate"
  alarm_description   = "More than ${var.error_rate_threshold_percent}% of requests answered 5xx (NFR-08, OPS-07). See docs/runbooks/incident-response.md."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.error_rate_threshold_percent
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "rate"
    expression  = "100 * (FILL(target5xx, 0) + FILL(elb5xx, 0)) / IF(requests > 0, requests, 1)"
    label       = "5xx percent"
    return_data = true
  }

  metric_query {
    id = "target5xx"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }

  metric_query {
    id = "elb5xx"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }

  metric_query {
    id = "requests"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each = var.target_group_arn_suffixes

  alarm_name          = "${var.name}-unhealthy-${each.key}"
  alarm_description   = "Unhealthy targets in ${each.key} (OPS-07)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ----- Metrics published from /internal/metrics by the collector sidecar ------------------------------------------

resource "aws_cloudwatch_metric_alarm" "queue_lag" {
  for_each = toset(var.queues)

  alarm_name          = "${var.name}-queue-lag-${each.key}"
  alarm_description   = "Queue ${each.key} lag above ${var.queue_lag_threshold_seconds} s (OPS-07)."
  namespace           = var.metrics_namespace
  metric_name         = "montra_job_queue_lag_seconds"
  dimensions          = { queue = each.key }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.queue_lag_threshold_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "reconciliation" {
  alarm_name          = "${var.name}-reconciliation-failures"
  alarm_description   = "The ledger reconciliation found failures. This should never happen. Treat as Sev-1 and see docs/runbooks/incident-response.md."
  namespace           = var.metrics_namespace
  metric_name         = "montra_reconciliation_failures"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Nothing arriving means the collector, or the API under it, stopped reporting. Queue and reconciliation alarms can't
# fire while that lasts, so it gets its own alarm.
resource "aws_cloudwatch_metric_alarm" "metrics_missing" {
  alarm_name          = "${var.name}-metrics-missing"
  alarm_description   = "No samples from the metrics collector for 15 minutes. Queue and reconciliation alarms are blind until this clears."
  namespace           = var.metrics_namespace
  metric_name         = "montra_reconciliation_failures"
  statistic           = "SampleCount"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ----- Backups ----------------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "backup_jobs_failed" {
  alarm_name          = "${var.name}-backup-jobs-failed"
  alarm_description   = "An AWS Backup job failed (BAK-01). See docs/runbooks/disaster-recovery.md."
  namespace           = "AWS/Backup"
  metric_name         = "NumberOfBackupJobsFailed"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "backup_copies_failed" {
  alarm_name          = "${var.name}-backup-copies-failed"
  alarm_description   = "An AWS Backup copy job failed (BAK-02). The second region or the backup account is missing a copy."
  namespace           = "AWS/Backup"
  metric_name         = "NumberOfCopyJobsFailed"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_event_rule" "backup_failures" {
  name        = "${var.name}-backup-failures"
  description = "AWS Backup and copy jobs that failed or were expired or aborted"

  event_pattern = jsonencode({
    source      = ["aws.backup"]
    detail-type = ["Backup Job State Change", "Copy Job State Change"]
    detail = {
      state = ["FAILED", "EXPIRED", "ABORTED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "backup_failures" {
  rule = aws_cloudwatch_event_rule.backup_failures.name
  arn  = aws_sns_topic.alarms.arn
}

# ----- Aurora -----------------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "aurora_cpu" {
  alarm_name          = "${var.name}-aurora-cpu"
  alarm_description   = "Aurora CPU above 80% for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBClusterIdentifier = var.aurora_cluster_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "aurora_memory" {
  alarm_name          = "${var.name}-aurora-memory"
  alarm_description   = "Aurora freeable memory below 512 MiB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  dimensions          = { DBClusterIdentifier = var.aurora_cluster_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 536870912
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "aurora_connections" {
  alarm_name          = "${var.name}-aurora-connections"
  alarm_description   = "Aurora connections above ${var.aurora_max_connections_alarm}."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBClusterIdentifier = var.aurora_cluster_identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.aurora_max_connections_alarm
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "aurora_replica_lag" {
  alarm_name          = "${var.name}-aurora-replica-lag"
  alarm_description   = "Aurora reader lag above 5 s for 15 minutes. The RPO depends on PITR, not on the reader, but failover and reports do."
  namespace           = "AWS/RDS"
  metric_name         = "AuroraReplicaLagMaximum"
  dimensions          = { DBClusterIdentifier = var.aurora_cluster_identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 5000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ----- ECS --------------------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks" {
  for_each = var.ecs_services

  alarm_name          = "${var.name}-tasks-${each.key}"
  alarm_description   = "Fewer than ${each.value} running tasks in ${each.key} (OPS-07)."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.key }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = each.value
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  for_each = var.ecs_services

  alarm_name          = "${var.name}-memory-${each.key}"
  alarm_description   = "Memory in ${each.key} above 90% of its reservation for 15 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.key }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
