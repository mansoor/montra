data "aws_iam_policy_document" "codedeploy_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codedeploy.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codedeploy" {
  name               = "${var.name}-codedeploy"
  assume_role_policy = data.aws_iam_policy_document.codedeploy_assume.json
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  role       = aws_iam_role.codedeploy.name
  policy_arn = "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS"
}

resource "aws_codedeploy_app" "this" {
  for_each = local.blue_green_services

  compute_platform = "ECS"
  name             = "${var.name}-${each.key}"
}

resource "aws_codedeploy_deployment_group" "this" {
  for_each = local.blue_green_services

  app_name               = aws_codedeploy_app.this[each.key].name
  deployment_group_name  = each.key
  service_role_arn       = aws_iam_role.codedeploy.arn
  deployment_config_name = var.deployment_config_name

  deployment_style {
    deployment_option = "WITH_TRAFFIC_CONTROL"
    deployment_type   = "BLUE_GREEN"
  }

  ecs_service {
    cluster_name = aws_ecs_cluster.this.name
    service_name = aws_ecs_service.blue_green[each.key].name
  }

  blue_green_deployment_config {
    deployment_ready_option {
      action_on_timeout = "CONTINUE_DEPLOYMENT"
    }

    terminate_blue_instances_on_deployment_success {
      action                           = "TERMINATE"
      termination_wait_time_in_minutes = var.termination_wait_minutes
    }
  }

  load_balancer_info {
    target_group_pair_info {
      prod_traffic_route {
        listener_arns = [var.https_listener_arn]
      }

      test_traffic_route {
        listener_arns = [var.test_listener_arn]
      }

      target_group {
        name = aws_lb_target_group.blue[each.key].name
      }

      target_group {
        name = aws_lb_target_group.green[each.key].name
      }
    }
  }

  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]
  }

  alarm_configuration {
    enabled = length(var.rollback_alarm_names) > 0
    alarms  = var.rollback_alarm_names
  }
}

# Everything the deploy workflow needs, in one place, so that GitHub only needs the role ARN and region.
resource "aws_ssm_parameter" "deploy_config" {
  name = "/${var.name}/deploy-config"
  type = "String"

  value = jsonencode({
    cluster       = aws_ecs_cluster.this.name
    subnets       = var.private_subnet_ids
    securityGroup = var.app_security_group_id
    repositories  = { for name, repository in aws_ecr_repository.this : name => repository.repository_url }
    blueGreen     = { for name in keys(local.blue_green_services) : name => { family = "${var.name}-${name}", application = aws_codedeploy_app.this[name].name, group = name, port = local.services[name].port } }
    rolling       = { for name, service in local.rolling_services : name => { family = "${var.name}-${name}", repository = service.repository } }
    migrate       = "${var.name}-migrate"
    kratosMigrate = "${var.name}-kratos-migrate"
    webBuildArgs = {
      NEXT_PUBLIC_AUTH_MODE  = "kratos"
      NEXT_PUBLIC_KRATOS_URL = local.auth_url
      NEXT_PUBLIC_APP_URL    = local.web_url
      NEXT_PUBLIC_API_WS_URL = "wss://${var.hostnames.api}/v1/ws"
    }
  })
}
