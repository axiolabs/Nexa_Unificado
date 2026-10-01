-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'HOST', 'MODERATOR', 'CURATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'PREMIUM');

-- CreateEnum
CREATE TYPE "PlaceCategory" AS ENUM ('CAFE', 'RESTAURANT', 'MUSEUM', 'PARK', 'WORKSHOP', 'SPORTS', 'BAR', 'LIBRARY', 'OTHER');

-- CreateEnum
CREATE TYPE "PriceLevel" AS ENUM ('FREE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "PlaceVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('OPEN', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('ORGANIZER', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "ParticipationStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'ATTENDED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "planTier" "PlanTier" NOT NULL DEFAULT 'FREE',
    "premiumUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRoleAssignment" (
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedById" TEXT,

    CONSTRAINT "UserRoleAssignment_pkey" PRIMARY KEY ("userId","role")
);

-- CreateTable
CREATE TABLE "AuthAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trait" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Trait_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "PlaceCategory" NOT NULL,
    "priceLevel" "PriceLevel" NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "verificationStatus" "PlaceVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaceTrait" (
    "placeId" TEXT NOT NULL,
    "traitId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PlaceTrait_pkey" PRIMARY KEY ("placeId","traitId")
);

-- CreateTable
CREATE TABLE "PersonalityTest" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalityTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalityQuestion" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "traitId" TEXT NOT NULL,

    CONSTRAINT "PersonalityQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalityOption" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scoreDelta" DOUBLE PRECISION NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "PersonalityOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalityResult" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalityResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalityAnswer" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,

    CONSTRAINT "PersonalityAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalityScore" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "traitId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PersonalityScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "placeId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "capacity" INTEGER NOT NULL,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "PlanStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanParticipant" (
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ParticipantRole" NOT NULL DEFAULT 'PARTICIPANT',
    "status" "ParticipationStatus" NOT NULL DEFAULT 'REQUESTED',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),

    CONSTRAINT "PlanParticipant_pkey" PRIMARY KEY ("planId","userId")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rating" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_planTier_idx" ON "User"("planTier");

-- CreateIndex
CREATE INDEX "User_emailVerifiedAt_idx" ON "User"("emailVerifiedAt");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_role_idx" ON "UserRoleAssignment"("role");

-- CreateIndex
CREATE INDEX "AuthAccount_userId_idx" ON "AuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthAccount_provider_providerAccountId_key" ON "AuthAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Trait_key_key" ON "Trait"("key");

-- CreateIndex
CREATE INDEX "Place_verificationStatus_category_priceLevel_idx" ON "Place"("verificationStatus", "category", "priceLevel");

-- CreateIndex
CREATE INDEX "Place_city_idx" ON "Place"("city");

-- CreateIndex
CREATE INDEX "Place_latitude_longitude_idx" ON "Place"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "Place_ownerId_idx" ON "Place"("ownerId");

-- CreateIndex
CREATE INDEX "PlaceTrait_traitId_idx" ON "PlaceTrait"("traitId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalityTest_version_key" ON "PersonalityTest"("version");

-- CreateIndex
CREATE INDEX "PersonalityQuestion_traitId_idx" ON "PersonalityQuestion"("traitId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalityQuestion_testId_order_key" ON "PersonalityQuestion"("testId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalityOption_questionId_order_key" ON "PersonalityOption"("questionId", "order");

-- CreateIndex
CREATE INDEX "PersonalityResult_userId_completedAt_idx" ON "PersonalityResult"("userId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalityResult_userId_testId_key" ON "PersonalityResult"("userId", "testId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalityAnswer_resultId_optionId_key" ON "PersonalityAnswer"("resultId", "optionId");

-- CreateIndex
CREATE INDEX "PersonalityScore_traitId_idx" ON "PersonalityScore"("traitId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalityScore_resultId_traitId_key" ON "PersonalityScore"("resultId", "traitId");

-- CreateIndex
CREATE INDEX "Plan_placeId_startsAt_idx" ON "Plan"("placeId", "startsAt");

-- CreateIndex
CREATE INDEX "Plan_creatorId_createdAt_idx" ON "Plan"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "Plan_status_startsAt_idx" ON "Plan"("status", "startsAt");

-- CreateIndex
CREATE INDEX "PlanParticipant_userId_status_idx" ON "PlanParticipant"("userId", "status");

-- CreateIndex
CREATE INDEX "PlanParticipant_planId_status_idx" ON "PlanParticipant"("planId", "status");

-- CreateIndex
CREATE INDEX "PlanParticipant_status_expiresAt_idx" ON "PlanParticipant"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Message_planId_createdAt_idx" ON "Message"("planId", "createdAt");

-- CreateIndex
CREATE INDEX "Rating_planId_idx" ON "Rating"("planId");

-- CreateIndex
CREATE INDEX "Rating_authorId_idx" ON "Rating"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "Rating_planId_authorId_key" ON "Rating"("planId", "authorId");

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccount" ADD CONSTRAINT "AuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Place" ADD CONSTRAINT "Place_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceTrait" ADD CONSTRAINT "PlaceTrait_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaceTrait" ADD CONSTRAINT "PlaceTrait_traitId_fkey" FOREIGN KEY ("traitId") REFERENCES "Trait"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalityQuestion" ADD CONSTRAINT "PersonalityQuestion_testId_fkey" FOREIGN KEY ("testId") REFERENCES "PersonalityTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalityQuestion" ADD CONSTRAINT "PersonalityQuestion_traitId_fkey" FOREIGN KEY ("traitId") REFERENCES "Trait"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalityOption" ADD CONSTRAINT "PersonalityOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "PersonalityQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalityResult" ADD CONSTRAINT "PersonalityResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalityResult" ADD CONSTRAINT "PersonalityResult_testId_fkey" FOREIGN KEY ("testId") REFERENCES "PersonalityTest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalityAnswer" ADD CONSTRAINT "PersonalityAnswer_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "PersonalityResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalityAnswer" ADD CONSTRAINT "PersonalityAnswer_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "PersonalityOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalityScore" ADD CONSTRAINT "PersonalityScore_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "PersonalityResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalityScore" ADD CONSTRAINT "PersonalityScore_traitId_fkey" FOREIGN KEY ("traitId") REFERENCES "Trait"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanParticipant" ADD CONSTRAINT "PlanParticipant_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanParticipant" ADD CONSTRAINT "PlanParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_planId_authorId_fkey" FOREIGN KEY ("planId", "authorId") REFERENCES "PlanParticipant"("planId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_planId_authorId_fkey" FOREIGN KEY ("planId", "authorId") REFERENCES "PlanParticipant"("planId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
