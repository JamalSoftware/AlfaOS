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

  /**
   * Politica de senha PPPoE da Alfa Telecom: ultimos 4 digitos do CPF.
   *
   * So dela. A Empresa Teste B fica no default MANUAL_ONLY de proposito, para
   * que a suite tenha um tenant sem derivacao e a regra nao possa virar
   * comportamento global sem alguem notar.
   */
  await prisma.company.update({
    where: { id: companyA.id },
    data: { pppoePasswordPolicy: "DOCUMENT_LAST4" },
  });

  await upsertUser({
    companyId: companyA.id,
    name: "Administrador Alfa",
    email: "admin@alfatelecom.local",
    profile: AccessProfile.ADMIN,
    password: DEMO_PASSWORD,
  });
  /*
    Um SEGUNDO administrador na empresa demonstração.

    Existe por causa da regra de quatro olhos da jornada (§253, LOW-1): quem
    abre uma correção para a PRÓPRIA jornada não pode decidi-la. Com um ADMIN
    só, esse pedido ficaria sem decisor possível no ambiente de demonstração, e
    o caminho legítimo não teria como ser mostrado nem testado.

    O nome não começa com "Administrador" de propósito: a tabela é ordenada por
    nome, e um segundo "Administrador…" mudaria a primeira linha e casaria por
    substring com as buscas por papel que outros testes já fazem.
  */
  await upsertUser({
    companyId: companyA.id,
    name: "Gestora Noturna Alfa",
    email: "admin2@alfatelecom.local",
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
    companyId: companyA.id,
    name: "Tecnico Beta",
    email: "tech2@alfatelecom.local",
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
    update: { provider: "MOCK", name: "Mock ERP", enabled: true },
    create: {
      companyId: companyA.id,
      provider: "MOCK",
      name: "Mock ERP",
      enabled: true,
    },
  });

  /**
   * Tipos iniciais para desenvolvimento e teste.
   *
   * Exemplos, NÃO enum: cada provedor tem seu vocabulário operacional, e nada
   * em produção precisa usar exatamente estes nomes. Um ADMIN cadastra,
   * renomeia e desativa os seus em Tipos de OS.
   */
  const DEFAULT_TYPES = [
    "Instalação",
    "Manutenção",
    "Recolhimento de equipamentos",
    "Entrega de carnê",
    "Troca de equipamento",
    "Visita técnica",
  ];

  for (let index = 0; index < DEFAULT_TYPES.length; index += 1) {
    const name = DEFAULT_TYPES[index];
    await prisma.serviceOrderType.upsert({
      where: { companyId_name: { companyId: companyA.id, name } },
      update: {},
      create: {
        companyId: companyA.id,
        name,
        sortOrder: (index + 1) * 10,
      },
    });
  }

  console.log("Seed complete.");
  console.log("Demo users (password: " + DEMO_PASSWORD + "):");
  console.log("  admin@alfatelecom.local      (Alfa Telecom - ADMIN)");
  console.log("  admin2@alfatelecom.local     (Alfa Telecom - ADMIN, 2o aprovador)");
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
