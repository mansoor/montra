resource "aws_appautoscaling_target" "this" {
  for_each = {
    api    = var.services.api
    web    = var.services.web
    worker = var.services.worker
  }

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${each.key}"
  min_capacity       = each.value.min
  max_capacity       = each.value.max

  depends_on = [aws_ecs_service.blue_green, aws_ecs_service.rolling]
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = toset(["api", "web"])

  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# Workers scale on queue lag. With several policies, the service scales out if any queue needs it and scales in only
# when all of them agree.
resource "aws_appautoscaling_policy" "worker_queue_lag" {
  for_each = toset(var.worker_scaling_queues)

  name               = "${var.name}-worker-lag-${each.key}"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this["worker"].service_namespace
  scalable_dimension = aws_appautoscaling_target.this["worker"].scalable_dimension
  resource_id        = aws_appautoscaling_target.this["worker"].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.worker_scaling_target_lag_seconds
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    customized_metric_specification {
      namespace   = var.metrics_namespace
      metric_name = "montra_job_queue_lag_seconds"
      statistic   = "Maximum"

      dimensions {
        name  = "queue"
        value = each.key
      }
    }
  }
}
