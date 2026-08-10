import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function daysFromNow(days: number, hours = 10, minutes = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function daysAgo(days: number, hours = 10, minutes = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

async function main() {
  console.log('Seeding database...');

  // --- Roles ---
  const roles = await Promise.all([
    prisma.role.upsert({ where: { name: 'admin' }, update: {}, create: { name: 'admin', description: 'Clinic Administrator' } }),
    prisma.role.upsert({ where: { name: 'dentist' }, update: {}, create: { name: 'dentist', description: 'Dentist' } }),
    prisma.role.upsert({ where: { name: 'assistant' }, update: {}, create: { name: 'assistant', description: 'Dental Assistant' } }),
    prisma.role.upsert({ where: { name: 'receptionist' }, update: {}, create: { name: 'receptionist', description: 'Receptionist' } }),
    prisma.role.upsert({ where: { name: 'patient' }, update: {}, create: { name: 'patient', description: 'Patient' } }),
  ]);

  const adminRole = roles.find(r => r.name === 'admin')!;
  const dentistRole = roles.find(r => r.name === 'dentist')!;
  const assistantRole = roles.find(r => r.name === 'assistant')!;
  const receptionistRole = roles.find(r => r.name === 'receptionist')!;
  const patientRole = roles.find(r => r.name === 'patient')!;

  console.log('Roles seeded');

  // --- Users (Staff) ---
  const password = await bcrypt.hash('password123', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@smileflow.com' },
    update: {},
    create: { email: 'admin@smileflow.com', passwordHash: password, firstName: 'Admin', lastName: 'User', phone: '555-0001', roleId: adminRole.id },
  });

  const dentist1 = await prisma.user.upsert({
    where: { email: 'dentist@smileflow.com' },
    update: {},
    create: { email: 'dentist@smileflow.com', passwordHash: password, firstName: 'Sarah', lastName: 'Johnson', phone: '555-0002', roleId: dentistRole.id },
  });

  const dentist2 = await prisma.user.upsert({
    where: { email: 'dentist2@smileflow.com' },
    update: {},
    create: { email: 'dentist2@smileflow.com', passwordHash: password, firstName: 'Michael', lastName: 'Chen', phone: '555-0003', roleId: dentistRole.id },
  });

  const assistant1 = await prisma.user.upsert({
    where: { email: 'assistant@smileflow.com' },
    update: {},
    create: { email: 'assistant@smileflow.com', passwordHash: password, firstName: 'Lisa', lastName: 'Park', phone: '555-0004', roleId: assistantRole.id },
  });

  const receptionist = await prisma.user.upsert({
    where: { email: 'receptionist@smileflow.com' },
    update: {},
    create: { email: 'receptionist@smileflow.com', passwordHash: password, firstName: 'Emily', lastName: 'Davis', phone: '555-0005', roleId: receptionistRole.id },
  });

  console.log('Staff users seeded');

  // --- Patients with user accounts (for portal login) ---
  const patientUserData = [
    { email: 'john.doe@example.com', firstName: 'John', lastName: 'Doe', phone: '555-0101', dob: '1985-06-15', gender: 'male', address: '123 Main St, Anytown, USA 12345', emergency: 'Jane Doe', emergencyPhone: '555-0102', medical: 'No significant medical history. Hypertension controlled with medication.', dental: 'Regular checkups, last visit 6 months ago. Previous filling on tooth #14.', allergies: 'Penicillin' },
    { email: 'sarah.williams@example.com', firstName: 'Sarah', lastName: 'Williams', phone: '555-0201', dob: '1990-03-22', gender: 'female', address: '456 Oak Ave, Sometown, USA 67890', emergency: 'Mike Williams', emergencyPhone: '555-0202', medical: 'Mild anxiety, takes anxiety medication.', dental: 'Previous root canal on tooth #19, crown on tooth #18.', allergies: 'Latex' },
    { email: 'mike.johnson@example.com', firstName: 'Mike', lastName: 'Johnson', phone: '555-0301', dob: '1978-11-08', gender: 'male', address: '789 Pine Rd, Othertown, USA 11223', emergency: 'Lisa Johnson', emergencyPhone: '555-0302', medical: 'Diabetes Type 2, well controlled.', dental: 'Periodontal disease, deep cleaning done 1 year ago. Missing tooth #36.', allergies: 'Aspirin, Sulfa drugs' },
    { email: 'emma.brown@example.com', firstName: 'Emma', lastName: 'Brown', phone: '555-0401', dob: '1995-07-30', gender: 'female', address: '321 Elm Blvd, Newcity, USA 44556', emergency: 'Tom Brown', emergencyPhone: '555-0402', medical: 'No significant medical history.', dental: 'Wisdom teeth removed 2 years ago. Otherwise healthy.', allergies: 'None known' },
    { email: 'david.lee@example.com', firstName: 'David', lastName: 'Lee', phone: '555-0501', dob: '1982-01-14', gender: 'male', address: '654 Maple Dr, Besttown, USA 77889', emergency: 'Anna Lee', emergencyPhone: '555-0502', medical: 'Asthma, uses inhaler as needed.', dental: 'Multiple fillings, crown on tooth #36. Needs root canal on tooth #46.', allergies: 'None known' },
  ];

  const patientUsers: Array<{ user: any; patient: any }> = [];
  for (const p of patientUserData) {
    const user = await prisma.user.upsert({
      where: { email: p.email },
      update: {},
      create: {
        email: p.email,
        passwordHash: password,
        firstName: p.firstName,
        lastName: p.lastName,
        phone: p.phone,
        roleId: patientRole.id,
      },
    });
    const existing = await prisma.patient.findFirst({ where: { userId: user.id } });
    const patient = existing || await prisma.patient.create({
      data: {
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        phone: p.phone,
        dateOfBirth: new Date(p.dob),
        gender: p.gender,
        address: p.address,
        emergencyContact: p.emergency,
        emergencyPhone: p.emergencyPhone,
        medicalHistory: p.medical,
        dentalHistory: p.dental,
        allergies: p.allergies,
        userId: user.id,
      },
    });
    patientUsers.push({ user, patient });
  }

  const [p1, p2, p3, p4, p5] = patientUsers.map(p => p.patient);
  console.log('Patients seeded');

  // --- Appointments (past and future) ---
  const appointments = [
    // Past appointments
    { patientId: p1.id, providerId: dentist1.id, start: daysAgo(14, 9, 0), end: daysAgo(14, 9, 30), status: 'completed', reason: 'Regular checkup', chair: 'Chair 1' },
    { patientId: p2.id, providerId: dentist1.id, start: daysAgo(12, 10, 0), end: daysAgo(12, 10, 45), status: 'completed', reason: 'Root canal follow-up', chair: 'Chair 2' },
    { patientId: p3.id, providerId: dentist2.id, start: daysAgo(10, 11, 0), end: daysAgo(10, 11, 30), status: 'completed', reason: 'Deep cleaning', chair: 'Chair 1' },
    { patientId: p4.id, providerId: dentist1.id, start: daysAgo(7, 9, 30), end: daysAgo(7, 10, 0), status: 'completed', reason: 'Post-surgery check', chair: 'Chair 3' },
    { patientId: p5.id, providerId: dentist2.id, start: daysAgo(5, 14, 0), end: daysAgo(5, 14, 30), status: 'no-show', reason: 'Crown fitting', chair: 'Chair 2' },
    { patientId: p1.id, providerId: dentist1.id, start: daysAgo(3, 10, 0), end: daysAgo(3, 10, 30), status: 'cancelled', reason: 'Consultation', chair: 'Chair 1' },
    // Future appointments
    { patientId: p1.id, providerId: dentist1.id, start: daysFromNow(1, 10, 0), end: daysFromNow(1, 10, 30), status: 'scheduled', reason: 'Filling replacement', chair: 'Chair 1' },
    { patientId: p2.id, providerId: dentist1.id, start: daysFromNow(2, 11, 0), end: daysFromNow(2, 11, 45), status: 'confirmed', reason: 'Crown preparation', chair: 'Chair 2' },
    { patientId: p3.id, providerId: dentist2.id, start: daysFromNow(3, 9, 0), end: daysFromNow(3, 9, 30), status: 'scheduled', reason: 'Implant consultation', chair: 'Chair 1' },
    { patientId: p4.id, providerId: dentist1.id, start: daysFromNow(4, 13, 0), end: daysFromNow(4, 13, 30), status: 'confirmed', reason: 'Teeth cleaning', chair: 'Chair 3' },
    { patientId: p5.id, providerId: dentist2.id, start: daysFromNow(5, 10, 0), end: daysFromNow(5, 10, 45), status: 'scheduled', reason: 'Root canal', chair: 'Chair 2' },
    { patientId: p1.id, providerId: dentist1.id, start: daysFromNow(7, 9, 0), end: daysFromNow(7, 9, 30), status: 'scheduled', reason: 'X-ray review', chair: 'Chair 1' },
    { patientId: p2.id, providerId: dentist2.id, start: daysFromNow(8, 14, 0), end: daysFromNow(8, 14, 30), status: 'scheduled', reason: 'Final crown fitting', chair: 'Chair 2' },
    { patientId: p3.id, providerId: dentist1.id, start: daysFromNow(10, 10, 0), end: daysFromNow(10, 11, 0), status: 'confirmed', reason: 'Implant placement', chair: 'Chair 1' },
  ];

  const createdAppointments = [];
  for (const apt of appointments) {
    const created = await prisma.appointment.create({
      data: {
        patientId: apt.patientId,
        providerId: apt.providerId,
        startTime: apt.start,
        endTime: apt.end,
        status: apt.status,
        reason: apt.reason,
        chairNumber: apt.chair,
      },
    });
    createdAppointments.push(created);
  }
  console.log(`${createdAppointments.length} appointments seeded`);

  // --- Clinical Charts and Tooth Entries ---
  const chart1 = await prisma.clinicalChart.create({
    data: {
      patientId: p1.id,
      appointmentId: createdAppointments[0].id,
      providerId: dentist1.id,
      clinicalNotes: 'Patient presents for routine examination. No complaints. Existing amalgam filling on tooth #14 showing wear. Recommended replacement with composite. Good oral hygiene overall.',
      toothEntries: {
        create: [
          { toothNumber: 14, surface: 'MO', condition: 'filling', procedure: 'Amalgam replacement', status: 'planned', notes: 'Replace with composite' },
          { toothNumber: 36, condition: 'healthy', status: 'completed' },
          { toothNumber: 26, surface: 'O', condition: 'cavity', procedure: 'Composite filling', status: 'planned', notes: 'Small occlusal cavity' },
        ],
      },
    },
  });

  const chart2 = await prisma.clinicalChart.create({
    data: {
      patientId: p2.id,
      appointmentId: createdAppointments[1].id,
      providerId: dentist1.id,
      clinicalNotes: 'Follow-up after root canal on tooth #19. Healing well. No pain or swelling. Recommended crown placement within 4 weeks.',
      toothEntries: {
        create: [
          { toothNumber: 19, condition: 'root_canal', procedure: 'Root canal completed', status: 'completed', notes: 'Follow-up crown needed' },
          { toothNumber: 18, condition: 'crown', status: 'completed', notes: 'Existing crown, good condition' },
        ],
      },
    },
  });

  const chart3 = await prisma.clinicalChart.create({
    data: {
      patientId: p3.id,
      appointmentId: createdAppointments[2].id,
      providerId: dentist2.id,
      clinicalNotes: 'Deep cleaning completed. Moderate periodontal pockets (4-5mm) in posterior regions. Recommended 3-month recall for periodontal maintenance. Missing tooth #36 - discussed implant options.',
      toothEntries: {
        create: [
          { toothNumber: 36, condition: 'missing', status: 'completed', notes: 'Extracted 2 years ago, implant candidate' },
          { toothNumber: 16, condition: 'healthy', status: 'completed', notes: 'Post-deep cleaning' },
          { toothNumber: 26, condition: 'healthy', status: 'completed', notes: 'Post-deep cleaning' },
        ],
      },
    },
  });

  console.log('Clinical charts and tooth entries seeded');

  // --- Treatment Plans ---
  const tp1 = await prisma.treatmentPlan.create({
    data: {
      patientId: p1.id,
      providerId: dentist1.id,
      title: 'Comprehensive Restorative Plan',
      description: 'Replace worn amalgam filling and address new cavity.',
      status: 'approved',
      estimatedCost: 420,
      items: {
        create: [
          { procedureCode: 'D2391', description: 'Composite filling - posterior, one surface', cost: 180, status: 'planned', teethInvolved: 14, notes: 'Replace amalgam' },
          { procedureCode: 'D2391', description: 'Composite filling - posterior, one surface', cost: 160, status: 'planned', teethInvolved: 26 },
          { procedureCode: 'D0220', description: 'Intraoral periapical', cost: 35, status: 'completed', teethInvolved: 14 },
          { procedureCode: 'D0220', description: 'Intraoral periapical', cost: 35, status: 'completed', teethInvolved: 26 },
        ],
      },
    },
  });

  const tp2 = await prisma.treatmentPlan.create({
    data: {
      patientId: p2.id,
      providerId: dentist1.id,
      title: 'Crown Restoration for Root Canal Tooth',
      description: 'Place crown on tooth #19 following root canal treatment.',
      status: 'in-progress',
      estimatedCost: 1200,
      items: {
        create: [
          { procedureCode: 'D2750', description: 'Porcelain crown (PFM)', cost: 1100, status: 'planned', teethInvolved: 19 },
          { procedureCode: 'D8670', description: 'Post and core buildup', cost: 100, status: 'completed', teethInvolved: 19 },
        ],
      },
    },
  });

  const tp3 = await prisma.treatmentPlan.create({
    data: {
      patientId: p3.id,
      providerId: dentist2.id,
      title: 'Implant Treatment Plan',
      description: 'Single implant placement for missing tooth #36.',
      status: 'planned',
      estimatedCost: 3500,
      items: {
        create: [
          { procedureCode: 'D6010', description: 'Implant placement - posterior', cost: 2500, status: 'planned', teethInvolved: 36 },
          { procedureCode: 'D6056', description: 'Implant abutment', cost: 500, status: 'planned', teethInvolved: 36 },
          { procedureCode: 'D6058', description: 'Implant crown', cost: 500, status: 'planned', teethInvolved: 36 },
        ],
      },
    },
  });

  const tp4 = await prisma.treatmentPlan.create({
    data: {
      patientId: p5.id,
      providerId: dentist2.id,
      title: 'Root Canal Therapy',
      description: 'Root canal treatment on tooth #46 with crown restoration.',
      status: 'planned',
      estimatedCost: 1800,
      items: {
        create: [
          { procedureCode: 'D3310', description: 'Root canal - molar', cost: 1200, status: 'planned', teethInvolved: 46 },
          { procedureCode: 'D2750', description: 'Porcelain crown (PFM)', cost: 600, status: 'planned', teethInvolved: 46 },
        ],
      },
    },
  });

  console.log('Treatment plans seeded');

  // --- Invoices ---
  const inv1 = await prisma.invoice.create({
    data: {
      patientId: p1.id,
      treatmentPlanId: tp1.id,
      appointmentId: createdAppointments[0].id,
      invoiceNumber: 'INV-2026-001',
      subtotal: 70,
      tax: 5.60,
      total: 75.60,
      status: 'paid',
      issuedAt: daysAgo(14),
      dueAt: daysAgo(-16),
      items: {
        create: [
          { description: 'Periodic oral evaluation', procedureCode: 'D0120', quantity: 1, unitPrice: 70, total: 70 },
        ],
      },
      payments: {
        create: [
          { amount: 75.60, method: 'credit_card', reference: 'CC-001', paidAt: daysAgo(14) },
        ],
      },
    },
  });

  const inv2 = await prisma.invoice.create({
    data: {
      patientId: p2.id,
      treatmentPlanId: tp2.id,
      appointmentId: createdAppointments[1].id,
      invoiceNumber: 'INV-2026-002',
      subtotal: 100,
      tax: 8.00,
      total: 108.00,
      status: 'paid',
      issuedAt: daysAgo(12),
      dueAt: daysAgo(-14),
      items: {
        create: [
          { description: 'Root canal follow-up visit', procedureCode: 'D0120', quantity: 1, unitPrice: 100, total: 100 },
        ],
      },
      payments: {
        create: [
          { amount: 108.00, method: 'cash', paidAt: daysAgo(12) },
        ],
      },
    },
  });

  const inv3 = await prisma.invoice.create({
    data: {
      patientId: p3.id,
      treatmentPlanId: tp3.id,
      invoiceNumber: 'INV-2026-003',
      subtotal: 150,
      tax: 12.00,
      total: 162.00,
      status: 'unpaid',
      issuedAt: daysAgo(10),
      dueAt: daysFromNow(20),
      items: {
        create: [
          { description: 'Implant consultation and planning', procedureCode: 'D0190', quantity: 1, unitPrice: 150, total: 150 },
        ],
      },
    },
  });

  const inv4 = await prisma.invoice.create({
    data: {
      patientId: p5.id,
      treatmentPlanId: tp4.id,
      invoiceNumber: 'INV-2026-004',
      subtotal: 200,
      tax: 16.00,
      total: 216.00,
      status: 'partial',
      issuedAt: daysAgo(5),
      dueAt: daysFromNow(25),
      items: {
        create: [
          { description: 'Consultation and X-rays', procedureCode: 'D0190', quantity: 1, unitPrice: 150, total: 150 },
          { description: 'Panoramic X-ray', procedureCode: 'D0330', quantity: 1, unitPrice: 50, total: 50 },
        ],
      },
      payments: {
        create: [
          { amount: 100.00, method: 'debit_card', reference: 'DC-001', paidAt: daysAgo(5) },
        ],
      },
    },
  });

  const inv5 = await prisma.invoice.create({
    data: {
      patientId: p1.id,
      appointmentId: createdAppointments[0].id,
      invoiceNumber: 'INV-2026-005',
      subtotal: 320,
      tax: 25.60,
      total: 345.60,
      status: 'unpaid',
      issuedAt: daysAgo(14),
      dueAt: daysFromNow(16),
      items: {
        create: [
          { description: 'Composite filling - tooth #14', procedureCode: 'D2391', quantity: 1, unitPrice: 180, total: 180 },
          { description: 'Composite filling - tooth #26', procedureCode: 'D2391', quantity: 1, unitPrice: 140, total: 140 },
        ],
      },
    },
  });

  console.log('Invoices seeded');

  // --- Notifications ---
  await prisma.notification.createMany({
    data: [
      { patientId: p1.id, userId: dentist1.id, type: 'reminder', channel: 'email', subject: 'Appointment Reminder', content: 'Your appointment is tomorrow at 10:00 AM with Dr. Johnson.', status: 'sent', scheduledAt: daysAgo(1), sentAt: daysAgo(1) },
      { patientId: p2.id, userId: dentist1.id, type: 'reminder', channel: 'sms', subject: 'Appointment Confirmation', content: 'Your crown preparation appointment is confirmed for the day after tomorrow at 11:00 AM.', status: 'sent', scheduledAt: daysAgo(1), sentAt: daysAgo(1) },
      { patientId: p1.id, userId: dentist1.id, type: 'recall', channel: 'email', subject: 'Treatment Follow-up', content: 'Your treatment plan items are ready to be scheduled. Please contact us to book your filling appointments.', status: 'pending' },
      { patientId: p5.id, userId: dentist2.id, type: 'follow-up', channel: 'email', subject: 'Missed Appointment Follow-up', content: 'We noticed you missed your recent appointment. Would you like to reschedule your crown fitting?', status: 'pending' },
      { patientId: p3.id, userId: dentist2.id, type: 'reminder', channel: 'sms', subject: 'Payment Reminder', content: 'You have an outstanding invoice of $162.00 (INV-2026-003). Please make payment at your earliest convenience.', status: 'sent', scheduledAt: daysAgo(2), sentAt: daysAgo(2) },
    ],
  });

  console.log('Notifications seeded');
  console.log('Seed completed successfully!');
  console.log('\n--- Login Credentials ---');
  console.log('Admin:         admin@smileflow.com / password123');
  console.log('Dentist 1:     dentist@smileflow.com / password123');
  console.log('Dentist 2:     dentist2@smileflow.com / password123');
  console.log('Assistant:     assistant@smileflow.com / password123');
  console.log('Receptionist:  receptionist@smileflow.com / password123');
  console.log('Patient 1:     john.doe@example.com / password123');
  console.log('Patient 2:     sarah.williams@example.com / password123');
  console.log('Patient 3:     mike.johnson@example.com / password123');
  console.log('Patient 4:     emma.brown@example.com / password123');
  console.log('Patient 5:     david.lee@example.com / password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
