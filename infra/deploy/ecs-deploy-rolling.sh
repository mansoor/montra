#!/usr/bin/env bash
# Registers a new task definition with a given image and rolls an ECS service onto it. The circuit breaker rolls the
# service back if its tasks don't start, and this script then fails.
#   ecs-deploy-rolling.sh <deploy-config-json-file> <service> <image>
set -euo pipefail

config_file=$1
service=$2
image=$3

cluster=$(jq -r .cluster "$config_file")
family=$(jq -r --arg s "$service" '.rolling[$s].family' "$config_file")

task_definition=$(
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
    jq --arg image "$image" --arg name "$service" '
      (.containerDefinitions[] | select(.name == $name) | .image) = $image
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)'
)
task_definition_arn=$(
  aws ecs register-task-definition --cli-input-json "$task_definition" \
    --query taskDefinition.taskDefinitionArn --output text
)

aws ecs update-service --cluster "$cluster" --service "$service" --task-definition "$task_definition_arn" \
  --query service.serviceName --output text

aws ecs wait services-stable --cluster "$cluster" --services "$service"

current=$(aws ecs describe-services --cluster "$cluster" --services "$service" --query 'services[0].taskDefinition' --output text)
if [ "$current" != "$task_definition_arn" ]; then
  echo "::error::$service rolled back to $current"
  exit 1
fi
echo "$service deployed"
