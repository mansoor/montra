resource "aws_lb_target_group" "blue" {
  for_each = local.blue_green_services

  name                 = "${var.name}-${each.key}-blue"
  port                 = local.services[each.key].port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = local.health_check_paths[each.key]
    matcher             = "200-399"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "green" {
  for_each = local.blue_green_services

  name                 = "${var.name}-${each.key}-green"
  port                 = local.services[each.key].port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = local.health_check_paths[each.key]
    matcher             = "200-399"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "kratos" {
  name                 = "${var.name}-kratos"
  port                 = 4433
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = local.health_check_paths["kratos"]
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# The metrics endpoint answers only on the private network. It also has a bearer token and a Cloudflare block.
resource "aws_lb_listener_rule" "deny_metrics" {
  listener_arn = var.https_listener_arn
  priority     = 10

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }

  condition {
    host_header {
      values = [var.hostnames.api]
    }
  }

  condition {
    path_pattern {
      values = ["/internal/metrics", "/internal/metrics/*"]
    }
  }
}

resource "aws_lb_listener_rule" "blue_green" {
  for_each = { for index, name in sort(keys(local.blue_green_services)) : name => index }

  listener_arn = var.https_listener_arn
  priority     = 100 + each.value

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.blue[each.key].arn
  }

  condition {
    host_header {
      values = [local.blue_green_services[each.key]]
    }
  }

  # CodeDeploy swaps the target group on each deployment.
  lifecycle {
    ignore_changes = [action]
  }
}

# Keeps the green target group attached to the load balancer, which ECS needs before it can register tasks in it.
resource "aws_lb_listener_rule" "blue_green_test" {
  for_each = { for index, name in sort(keys(local.blue_green_services)) : name => index }

  listener_arn = var.test_listener_arn
  priority     = 100 + each.value

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.green[each.key].arn
  }

  condition {
    host_header {
      values = [local.blue_green_services[each.key]]
    }
  }

  # CodeDeploy swaps the target group on each deployment.
  lifecycle {
    ignore_changes = [action]
  }
}

resource "aws_lb_listener_rule" "kratos" {
  listener_arn = var.https_listener_arn
  priority     = 200

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.kratos.arn
  }

  condition {
    host_header {
      values = [var.hostnames.auth]
    }
  }
}
