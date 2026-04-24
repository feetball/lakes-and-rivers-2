/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ['leaflet', 'react-leaflet'],
  },
};

export default nextConfig;
