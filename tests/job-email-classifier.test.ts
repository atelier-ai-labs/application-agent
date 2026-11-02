/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { classifyJobEmail } from "../application-agent/src/domain/jobEmailClassifier";

const email = (subject: string, text: string, from = "no-reply@us.greenhouse-mail.io") => ({ from, subject, text });

describe("job email classification", () => {
  it("recognizes rejections, even when they thank the candidate", () => {
    expect(classifyJobEmail(email("Your application to Upstart", "Thank you for your interest in Upstart. After careful review, we have decided to move forward with other candidates whose experience more closely matches our needs."))).toBe("rejection");
    expect(classifyJobEmail(email("Update on your candidacy", "Unfortunately, we will not be moving forward with your application at this time."))).toBe("rejection");
    expect(classifyJobEmail(email("Plane - Software Engineer", "We regret to inform you that the position has been filled."))).toBe("rejection");
    expect(classifyJobEmail(email("Follow up from Upstart", "Thank you for your interest in joining Upstart and applying to the DevOps Engineer II, Cloud Platform position. Regrettably, we have decided to move forward with others at this time.", "no-reply@recruiting.upstart.com"))).toBe("rejection");
  });

  it("recognizes callbacks and interview invitations", () => {
    expect(classifyJobEmail(email("Next steps with Stack AV", "Hi Nathaniel, we'd like to schedule a call to learn more about you. Please select a time that works.", "recruiter@stackav.com"))).toBe("interview");
    expect(classifyJobEmail(email("Interview invitation – Clair", "We're excited to invite you to a phone screen with our team."))).toBe("interview");
  });

  it("recognizes application-received emails", () => {
    expect(classifyJobEmail(email("Thank you for applying to Cargomatic", "We have received your application and will review it shortly."))).toBe("received");
  });

  it("leaves unclear job mail for the user and ignores non-job mail", () => {
    expect(classifyJobEmail(email("Quick question about your application", "Could you send your portfolio link?"))).toBe("unclear");
    expect(classifyJobEmail(email("Security code for your application to Upstart", "Copy and paste this code into the security code field: abc12345"))).toBe("not_job");
    expect(classifyJobEmail(email("New jobs for you", "20 new jobs matching Platform Engineer"))).toBe("not_job");
    expect(classifyJobEmail(email("Your order has shipped", "Tracking number 123"))).toBe("not_job");
  });
});
