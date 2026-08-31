import { proxyActivities } from '@temporalio/workflow';

const { executePaidOpportunity } = proxyActivities({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '60 seconds',
  retry: { initialInterval:'15 seconds', maximumInterval:'5 minutes', backoffCoefficient:2, maximumAttempts:5 }
});

export async function paidJobWorkflow(payload){
  return executePaidOpportunity(payload);
}
