// Body of billing.charge. Stands in for a real payment provider.

interface Input {
  customer: string;
  amount: number;
}

interface Ports {
  ids: { next(prefix: string): string };
  log: { info(message: string): void; warn(message: string): void };
}

export default async function charge({ customer, amount }: Input, { ids, log }: Ports) {
  if (amount > 500) {
    log.warn(`declined ${amount} for ${customer}: over the limit`);
    return { declined: { reason: "Amounts over 500 need manual approval" } };
  }
  if (customer === "blocked@example.com") {
    return { declined: { reason: "The card was declined" } };
  }
  const payment_id = ids.next("pay");
  log.info(`charged ${amount} to ${customer}`);
  return { paid: { payment_id } };
}
