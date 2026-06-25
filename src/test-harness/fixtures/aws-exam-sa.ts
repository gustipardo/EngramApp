import type { AnkiCard } from "../../types/anki";

/**
 * Subset of the AWS Exam SA deck for replay tests.
 * Source: ./aws-exam-sa.txt (Anki TSV export).
 *
 * Selection criteria: short, unambiguous, single-line answers. Avoids
 * cards with HTML lists, multi-paragraph backs, or cards whose answer
 * is also embedded in the question — those add noise to grading
 * assertions.
 */
export const awsExamSaCards: AnkiCard[] = [
  {
    cardId: 1001,
    cardOrd: 0,
    front:
      "Network ACL (Access Control List) controls inbound and outbound traffic at what level?",
    back: "subnet level",
    deckName: "Aws Exam SA",
  },
  {
    cardId: 1002,
    cardOrd: 0,
    front: "Amazon Data Lifecycle Manager (AWS DLM) is used for what?",
    back: "Automated Backup of EBS Volumes (snapshots)",
    deckName: "Aws Exam SA",
  },
  {
    cardId: 1003,
    cardOrd: 0,
    front: "Can you whitelist fixed IP addresses on an ELB?",
    back: "Only with a Network Load Balancer, by associating Elastic IP addresses. Application Load Balancers do not have fixed IPs.",
    deckName: "Aws Exam SA",
  },
  {
    cardId: 1004,
    cardOrd: 0,
    front: "Amazon GuardDuty is what kind of service?",
    back: "a threat detection service",
    deckName: "Aws Exam SA",
  },
  {
    cardId: 1005,
    cardOrd: 0,
    front:
      "AWS Direct Connect: low latency, high bandwidth, and what else? Better than what alternative?",
    back: "more consistent performance; better than a VPN",
    deckName: "Aws Exam SA",
  },
];
