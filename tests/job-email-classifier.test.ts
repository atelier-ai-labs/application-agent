/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { classifyJobEmail } from "../application-agent/src/domain/jobEmailClassifier";

const email = (subject: string, text: string, from = "no-reply@us.greenhouse-mail.io") => ({ from, subject, text });

describe("job email classification", () => {
  it("recognizes rejections, even when they thank the candidate", () => {
    expect(classifyJobEmail(email("Your application to Upstart", "Thank you for your interest in Upstart. After careful review, we have decided to move forward with other candidates whose experience more closely matches our needs."))).toBe("rejection");
    expect(classifyJobEmail(email("Update on your candidacy", "Unfortunately, we will not be moving forward with your application at this time."))).toBe("rejection");
    expect(classifyJobEmail(email("Plane - Software Engineer", "We regret to inform you that the position has been filled."))).toBe("rejection");
    // Upstart's application limit (2026-11-11).
    expect(classifyJobEmail(email("Update on Your Application at Upstart", "Please note that candidates may apply to up to three roles within a 60 day period. At this time, you have reached that limit, so we will not be able to move forward with your most recent application.", "no-reply@upstart.com"))).toBe("rejection");
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

  it("reads 'we will contact you about next steps in the interview process' in a receipt as a receipt", () => {
    // Mission Underwriting's receipt, word for word: an interview is only a possibility.
    expect(classifyJobEmail(email("Thank You For Applying To Mission Underwriting Managers",
      "Hi Nathaniel , Thank you for applying to Mission Underwriting Managers! We have received your application and will review it promptly. If we think your background is a good fit, we will contact you regarding next steps in the interview process. Position: Applied AI Engineer",
      "Mission Underwriting Services <no-reply@ats.rippling.com>"))).toBe("received");
    expect(classifyJobEmail(email("Thank you for applying to Cargomatic",
      "Thank you for applying to our opportunity at Cargomatic. We have received your application and will review it promptly. If your background aligns with the role, a member of our team will be in touch to schedule a call."))).toBe("received");
    expect(classifyJobEmail(email("Thanks for applying!", "We'll review your application and reach out to you to set up a phone screen if it's a match."))).toBe("received");
  });

  it("still sees a real invitation, even when it also has an 'if' sentence", () => {
    expect(classifyJobEmail(email("Next steps with Acme", "Thanks for applying! We'd like to schedule a call with you to discuss the role. If none of the times work, just reply."))).toBe("interview");
    expect(classifyJobEmail(email("Interview with Acme", "Please select a time for your recruiter screen using the link below."))).toBe("interview");
  });

  it("handles the wording of real receipts and rejections from the inbox", () => {
    // Arize: the receipt links "read this interview with Arize co-founder ..." (a blog post).
    expect(classifyJobEmail(email("Thank you for your application to Arize AI!",
      "Thank you so much for your interest in a career at Arize AI! We'll review your application, and if there's a fit, you can expect to hear from a member of our team soon to set up an intro call. Learn About Arize AI: read this interview with Arize co-founder and Chief Product Officer Aparna Dhinakaran."))).toBe("received");
    expect(classifyJobEmail(email("Nathaniel, Thanks From Stack AV!",
      "Thanks so much for your interest in Stack AV! With all the opportunities out there, we appreciate you showing interest in our role. If your application seems like a good fit for the position we will contact you soon."))).toBe("received");
    expect(classifyJobEmail(email("Thank you for applying, Nathaniel!",
      "Thanks again for your interest in learning more about this role at Stack AV. Unfortunately, at this time we have decided not to proceed with your candidacy."))).toBe("rejection");
    expect(classifyJobEmail(email("Your interview with Acme", "Here are the details for your interview with the platform team on Tuesday."))).toBe("interview");
  });
});
