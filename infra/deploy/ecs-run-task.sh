#!/usr/bin/env bash
# Runs a one-off ECS task with a given image, waits for it and fails if it failed. Used for migrations.
#   ecs-run-task.sh <deploy-config-json-file> <family> <image>
set -euo pipefail

config_file=$1
family=$2
image=$3

cluster=$(jq -r .cluster "$config_file")
subnets=$(jq -r '.subnets | join(",")' "$config_file")
security_group=$(jq -r .securityGroup "$config_file")

task_definition=$(
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json |
    jq --arg image "$image" '
      .containerDefinitions[0].image = $image
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)'
)
task_definition_arn=$(
  aws ecs register-task-definition --cli-input-json "$task_definition" \
    --query taskDefinition.taskDefinitionArn --output text
)

echo "Running $task_definition_arn"
task_arn=$(
  aws ecs run-task \
    --cluster "$cluster" \
    --launch-type FARGATE \
    --task-definition "$task_definition_arn" \
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$security_group],assignPublicIp=DISABLED}" \
    --query 'tasks[0].taskArn' --output text
)
if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
  echo "::error::ECS did not start the $family task"
  exit 1
fi

aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn"

exit_code=$(
  aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
    --query 'tasks[0].containers[0].exitCode' --output text
)
if [ "$exit_code" != "0" ]; then
  reason=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --query 'tasks[0].stoppedReason' --output text)
  echo "::error::$family exited with code $exit_code ($reason). See the log group for this task."
  exit 1
fi
echo "$family finished"
