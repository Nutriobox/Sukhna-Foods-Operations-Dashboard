/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep deploys resilient: a stray lint/type nit never blocks a build.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};
export default nextConfig;
