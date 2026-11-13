resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = merge(local.services, local.one_off_tasks)

  name              = "/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "metrics" {
  name              = "/${var.name}/metrics"
  retention_in_days = 7
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = local.service_discovery_namespace
  description = "Private names for services that aren't behind the ALB"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "kratos" {
  name = "kratos"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each = local.services

  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[startswith(each.key, "kratos") ? "kratos" : each.key].arn

  container_definitions = jsonencode(concat(
    [merge(
      {
        name        = each.key
        image       = "${aws_ecr_repository.this[each.value.repository].repository_url}:${var.image_tag}"
        essential   = true
        stopTimeout = each.value.stop_timeout
        environment = [for k, v in each.value.environment : { name = k, value = v }]
        secrets     = [for k, v in each.value.secrets : { name = k, valueFrom = aws_secretsmanager_secret.this[v].arn }]
        portMappings = each.value.port == null ? [] : concat(
          [{ containerPort = each.value.port, protocol = "tcp" }],
          each.key == "kratos" ? [{ containerPort = 4434, protocol = "tcp" }] : [],
        )
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
            awslogs-region        = local.region
            awslogs-stream-prefix = each.key
          }
        }
      },
      each.value.command == null ? {} : { command = each.value.command },
    )],
    each.value.collector ? [{
      name      = "metrics-collector"
      image     = var.collector_image
      essential = false
      environment = [
        { name = "AOT_CONFIG_CONTENT", value = local.collector_config },
      ]
      secrets = [
        { name = "METRICS_TOKEN", valueFrom = aws_secretsmanager_secret.this["METRICS_TOKEN"].arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = local.region
          awslogs-stream-prefix = "metrics-collector"
        }
      }
    }] : [],
  ))
}

resource "aws_ecs_task_definition" "one_off" {
  for_each = local.one_off_tasks

  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name        = each.key
    image       = "${aws_ecr_repository.this[each.value.repository].repository_url}:${var.image_tag}"
    essential   = true
    command     = each.value.command
    environment = [for k, v in each.value.environment : { name = k, value = v }]
    secrets     = [for k, v in each.value.secrets : { name = k, valueFrom = aws_secretsmanager_secret.this[v].arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
        awslogs-region        = local.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

# ----- Blue/green services (OPS-03): deployed by CodeDeploy, see deploy.tf ---------------------------------------------

resource "aws_ecs_service" "blue_green" {
  for_each = local.blue_green_services

  name                              = each.key
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.service[each.key].arn
  desired_count                     = local.services[each.key].desired
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  propagate_tags                    = "SERVICE"

  deployment_controller {
    type = "CODE_DEPLOY"
  }

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [var.app_security_group_id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.blue[each.key].arn
    container_name   = each.key
    container_port   = local.services[each.key].port
  }

  # CodeDeploy owns all three after the first deployment; autoscaling owns the count.
  lifecycle {
    ignore_changes = [task_definition, load_balancer, desired_count]
  }

  depends_on = [aws_lb_listener_rule.blue_green, aws_lb_listener_rule.blue_green_test]
}

# ----- Rolling services: no load balancer in front (or Cloud Map needed), so CodeDeploy can't be used -----------------

resource "aws_ecs_service" "rolling" {
  for_each = local.rolling_services

  name                               = each.key
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.service[each.key].arn
  desired_count                      = each.value.desired
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = each.key == "kratos-courier" ? 0 : 100
  deployment_maximum_percent         = each.key == "kratos-courier" ? 100 : 200
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = each.key == "auth-gateway" ? 60 : null

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [var.app_security_group_id]
  }

  dynamic "load_balancer" {
    for_each = each.key == "auth-gateway" ? [aws_lb_target_group.auth_gateway.arn] : []

    content {
      target_group_arn = load_balancer.value
      container_name   = "auth-gateway"
      container_port   = 4455
    }
  }

  dynamic "service_registries" {
    for_each = each.key == "kratos" ? [aws_service_discovery_service.kratos.arn] : []

    content {
      registry_arn = service_registries.value
    }
  }

  # deploy.yml moves the task definition forward; autoscaling owns the worker count.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener_rule.auth_gateway]
}
