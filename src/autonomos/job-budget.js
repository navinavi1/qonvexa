// Conservative per-job reservations, shared by planning, execution, tools and QA.
// Reservations are persisted before calls. They are estimates, not provider invoices.
export function createJobBudget(
  limitUsd,
  { onCost = () => {}, env = process.env } = {},
) {
  let spent = 0;
  return {
    get remaining() {
      return Math.max(0, Number(limitUsd) - spent);
    },
    get spent() {
      return spent;
    },
    charge(amount) {
      const value = Number(amount);
      if (!Number.isFinite(value) || value < 0 || value > this.remaining + 1e-9)
        throw new Error("job_spend_limit");
      spent += value;
      onCost(value);
    },
    llm(client) {
      const budget = this;
      return {
        ...client,
        budgeted: true,
        complete: async (args) => {
          const size =
            JSON.stringify(
              args.messages || [args.system || "", args.user || ""],
            ).length + JSON.stringify(args.tools || []).length;
          const amount =
            (size * Number(env.AUTONOMOS_LLM_INPUT_USD_PER_MILLION || 0.25) +
              Number(args.maxTokens || 700) *
                Number(env.AUTONOMOS_LLM_OUTPUT_USD_PER_MILLION || 2)) /
            1e6;
          budget.charge(amount);
          return client.complete({ ...args, maxEmptyRetries: 0 });
        },
      };
    },
  };
}
