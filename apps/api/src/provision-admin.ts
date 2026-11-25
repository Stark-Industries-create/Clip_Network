import { PrismaClient } from '@prisma/client';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: node apps/api/dist/provision-admin.js <verified-email>');
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const promoted = await prisma.user.updateMany({
    where: { email, emailVerifiedAt: { not: null }, status: 'ACTIVE' },
    data: { systemRole: 'SUPER_ADMIN' },
  });
  if (!promoted.count) {
    console.error('No active, verified account matches that email.');
    process.exitCode = 1;
  } else {
    console.log('Platform admin provisioned.');
  }
} finally {
  await prisma.$disconnect();
}
