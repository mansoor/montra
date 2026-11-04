output "alarm_topic_arn" {
  description = "SNS topic that receives every alarm."
  value       = aws_sns_topic.alarms.arn
}

output "error_rate_alarm_name" {
  description = "Alarm that CodeDeploy watches during a deployment."
  value       = aws_cloudwatch_metric_alarm.alb_5xx_rate.alarm_name
}
