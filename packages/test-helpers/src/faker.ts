import { createHash } from "node:crypto";
import { en, Faker } from "@faker-js/faker";

export function testFaker(seed: string | number): Faker {
  const faker = new Faker({ locale: en });
  const digest = createHash("sha256").update(String(seed)).digest();
  faker.seed(Array.from({ length: 8 }, (_, i) => digest.readUInt32LE(i * 4)));
  faker.setDefaultRefDate("2026-01-01T00:00:00.000Z");
  return faker;
}
