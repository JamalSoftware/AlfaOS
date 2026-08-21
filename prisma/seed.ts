import { PrismaClient, AccessProfile } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const DEMO_PASSWORD = "AlfaOS@2026";

async function upsertCompany(data: { name: string; document: string }) {
  return prisma.company.upsert({
    where: { document: data.document },
    update: { name: data.name },
    create: data,
  });
}

async function upsertUser(data: {
  companyId: string;
  name: string;
  email: string;
  profile: AccessProfile;
  password: string;
}) {
  const passwordHash = await bcrypt.hash(data.password, 12);
  return prisma.user.upsert({
    where: { email: data.email },
    update: {
      name: data.name,
      profile: data.profile,
      active: true,
    },
    create: {
      companyId: data.companyId,
      name: data.name,
      email: data.email,
      profile: data.profile,
      passwordHash,
    },
  });
}

async function main() {
  console.log("Seeding development database...");

  const companyA = await upsertCompany({
    name: "Alfa Telecom",
    document: "12.345.678/0001-90",
  });
  const companyB = await upsertCompany({
    name: "Empresa Teste B",
    document: "98.765.432/0001-01",
  });

  await upsertUser({
    companyId: companyA.id,
    name: "Administrador Alfa",
    email: "admin@alfatelecom.local",
    profile: AccessProfile.ADMIN,
    password: DEMO_PASSWORD,
  });
  await upsertUser({
    companyId: companyA.id,
    name: "Despachante Alfa",
    email: "dispatcher@alfatelecom.local",
    profile: AccessProfile.DISPATCHER,
    password: DEMO_PASSWORD,
  });
  await upsertUser({
    companyId: companyA.id,
    name: "Tecnico Alfa",
    email: "tech@alfatelecom.local",
    profile: AccessProfile.TECHNICIAN,
    password: DEMO_PASSWORD,
  });
  await upsertUser({
    companyId: companyB.id,
    name: "Administrador Empresa B",
    email: "admin@empresatesteb.local",
    profile: AccessProfile.ADMIN,
    password: DEMO_PASSWORD,
  });

  await prisma.eRPIntegration.upsert({
    where: { companyId: companyA.id },
    update: {},
    create: {
      companyId: companyA.id,
      provider: "MOCK",
      name: "Mock ERP",
    },
  });

  console.log("Seed complete.");
  console.log("Demo users (password: " + DEMO_PASSWORD + "):");
  console.log("  admin@alfatelecom.local      (Alfa Telecom - ADMIN)");
  console.log("  dispatcher@alfatelecom.local  (Alfa Telecom - DISPATCHER)");
  console.log("  tech@alfatelecom.local        (Alfa Telecom - TECHNICIAN)");
  console.log("  admin@empresatesteb.local     (Empresa Teste B - ADMIN)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
