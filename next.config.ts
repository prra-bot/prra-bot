import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  agentRules: false,
};

export default withWorkflow(nextConfig);
