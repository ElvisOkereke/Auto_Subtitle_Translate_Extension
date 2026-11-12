// Operator CLI for the subscription flag (no Stripe needed):
//   DB_PATH=/data/app.db node server/dist/admin.js set-plan <email> <free|standard|pro> [status]
import { applyPlan } from './billing';
import { Repo } from './db';

export function setPlanCommand(repo: Repo, args: string[]): string {
  const [command, email, plan, status] = args;
  if (command !== 'set-plan') throw new Error('usage: set-plan <email> <free|standard|pro> [status]');
  return applyPlan(repo, email, plan, status);
}

if (require.main === module) {
  const repo = new Repo(process.env.DB_PATH ?? 'app.db');
  try {
    console.log(setPlanCommand(repo, process.argv.slice(2)));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    repo.close();
  }
}
