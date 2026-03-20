import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const bootstrap = async (): Promise<void> => {
  const tags = ["newbie", "paid", "leader", "vip", "inactive", "russian", "germany"];
  const badges = [
    ["newbie", "Newbie"],
    ["active", "Active"],
    ["leader", "Leader"],
    ["top10", "Top 10"],
    ["vip", "VIP"]
  ] as Array<[string, string]>;

  for (const code of tags) {
    await prisma.tag.upsert({
      where: { code },
      update: {},
      create: {
        code,
        name: code
      }
    });
  }

  for (const [code, title] of badges) {
    await prisma.badge.upsert({
      where: { code },
      update: {},
      create: { code, title }
    });
  }
};

void bootstrap()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
