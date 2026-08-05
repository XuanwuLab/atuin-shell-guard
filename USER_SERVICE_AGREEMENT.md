# Atuin Shell Guard Plugin User Service Agreement
## Preamble

Welcome to the Atuin Shell Guard Plugin and its services (hereinafter referred to as the "Service")!

To use the Service, you should read and understand this *Atuin Shell Guard Plugin User Service Agreement* (hereinafter referred to as this "Agreement"), the *Atuin Shell Guard Plugin Privacy Policy*, and the service rules of the Service. Please read and understand each provision carefully, **particularly provisions that exempt or limit liability, provisions that restrict user rights, and provisions concerning dispute resolution and jurisdiction.** Provisions limiting or exempting liability, or other provisions involving your material rights and interests, are indicated in bold to draw your particular attention.

Atuin Shell Guard is a security-assistance plugin for AI Agent terminal operation scenarios, provided by Shenzhen Tencent Computer Systems Company Limited (hereinafter referred to as "we," "us," or "Tencent"). Before an Agent executes a shell command, the Service performs a risk assessment on such command, assisting in identifying behaviors that may result in important files being deleted, overwritten, moved, or modified in bulk, with the aim of reducing the risk of user data loss caused by erroneous AI Agent operations.

This Agreement is an agreement entered into between you and Tencent regarding your use of the Service. **By checking a box, clicking to confirm, registering, logging in, using the Service, or otherwise expressly or impliedly indicating your acceptance of this Agreement, you shall be deemed to have read and agreed to be bound by this Agreement.** If you do not agree to this Agreement, you may cease using the Service.

If you are under 18 years of age, please read this Agreement and determine whether to accept it under the supervision and accompaniment of your guardian, use the Service under your guardian's guidance, and pay particular attention to the provisions on use by minors.

This Agreement includes the main body of the Agreement as well as various service rules relating to the Service that we may publish from time to time. We may adjust this Agreement or the service rules in response to legal and regulatory requirements, changes in service content, or other circumstances, in which case such adjustments will be publicly announced on our webpages (or via push notifications, pop-up windows, or other lawful means). You may review the latest version of the Agreement on the relevant pages. **If you continue to use the Service after the Agreement has been adjusted, you will be deemed to have agreed to the amended content. If you do not accept the adjusted Agreement, you may cease using the Service.**

---

## 1. About the Service

**1.1 Scope of the Service:** The Service is provided to users through an AI Agent plugin or hook mechanism, and is applicable to AI Agent platforms that support terminal command execution, such as Claude Code, Codex CLI, Hermes Agent, and OpenClaw. The specific scope shall be subject to what we publish and actually provide.

**1.2** The Service serves as a security-assistance tool applied before an AI Agent executes terminal commands. Before an Agent executes a shell command, the Service performs a risk assessment on such command, assisting in identifying behaviors that may result in important files being deleted, overwritten, moved, or modified in bulk, with the aim of reducing the risk of user data loss caused by erroneous AI Agent operations.

**Please note that the Service is positioned as a "pre-execution safety guardrail" and is not a sandbox, antivirus product, EDR, DLP, or a complete malicious-code defense system.** The function of the Service is to identify high-risk operations before execution to the extent possible, and to issue warnings, block, or review such risks. The Service does not replace operating-system permission controls, nor does it isolate commands that have already been permitted. **Once a command has been permitted, its subsequent execution is carried out by your device, operating system, and Agent platform. Please carefully evaluate your use of the Service and bear the corresponding consequences.**

**1.3 Network Connectivity:** When the Service identifies a potentially risky Agent tool-invocation behavior on your device, we will upload the Agent tool-invocation command, necessary resource metadata, the randomly generated installation ID, conversation ID, and necessary telemetry data to the cloud for analysis, and will return the cloud-reviewed risk-assessment result to you. **Please note that the contents of your local files will not be uploaded to the cloud.** If you do not wish to use the cloud-based risk-analysis capability, you may at any time disable it as described in the README documentation or uninstall the plugin.

**1.4 Service Rules:** "Service Rules" refers to the terms of service, rules, instructions, standards, and similar materials concerning the content of the Service, service levels, technical specifications, operational documentation, billing standards, and related matters. The Service Rules shall be subject to the content displayed on the relevant pages of the Service. Please familiarize yourself with the Service Rules in advance and operate in accordance with them to ensure smooth use of the Service.

**1.5 Feature Updates:** To improve the user experience and enhance the content of the Service, we may update the Service or adjust certain features (for example, software upgrades, discontinuation of certain features, or development of new services). We will notify you by appropriate means (such as system prompts, announcements, or in-service messages), and you may choose to use the updated version. If you choose not to update, certain features of the Service may be restricted or may not function properly.

**1.6 Devices Required for the Service:** The Service requires that you have a compatible terminal device and operating system, and that such device is capable of maintaining a stable network connection (where the cloud-review feature is enabled); otherwise, certain features may not be available to you. The content and features of the Service may differ or change depending on the terminal model, operating system, Agent platform, and other factors applicable to you.

**1.7** Due to the technical characteristics of large language models and artificial intelligence, as well as the limitations of current technology, shell and other tool-invocation commands may involve dynamic construction, variable substitution, external script invocation, cross-platform differences, and similar characteristics. **The risk assessments provided by the Service may be subject to a degree of error; we cannot guarantee coverage of all scenarios, nor can we guarantee accurate identification of all high-risk commands.** For example, certain safe commands may be mistakenly identified as high-risk (false positives), and certain highly dynamic or deliberately obfuscated commands may not be fully identified (false negatives). **Accordingly, you understand and agree that the foregoing constitutes an inherent characteristic and limitation of risk-assessment technology based on large language models, and does not constitute a functional defect or error of the Service.** The Service should be regarded as a supplementary security measure; you must continue to exercise necessary attention and prudent judgment regarding the commands executed by the Agent, and you are asked to use the Service prudently, rationally, and in accordance with the law.

**1.8 Installation:** We may develop different plugin versions for different Agent platforms, and you should select and download the appropriate version for installation based on your circumstances. The installation methods, user-notification methods, blocking capabilities, and configuration capabilities may vary across different Agent platforms, subject to what we publish and actually provide.

---

## 2. Account Registration and Management

**2.1** The Service may be used without registering or logging into an account; you are not required to provide a mobile phone number or link any third-party account.

---

## 3. Your Rights and Obligations

**3.1** You have the right to use the Service in accordance with the provisions of this Agreement.

**3.2** You shall use the Service in accordance with the law and shall not use the Service to engage in illegal or non-compliant activities that endanger national security or the public interest, disrupt economic or social order, or infringe upon the lawful rights and interests of others, including, for example:

1. Opposing the fundamental principles established by the Constitution;
2. Endangering national security, divulging state secrets, subverting state power, or undermining national unity;
3. Harming national honor and interests;
4. Distorting, defaming, desecrating, or denying the deeds and spirit of heroes and martyrs, or infringing upon the names, likenesses, reputations, or honor of heroes and martyrs by way of insult, defamation, or other means;
5. Promoting terrorism or extremism, or inciting the commission of terrorist or extremist activities;
6. Inciting ethnic hatred or ethnic discrimination, or undermining ethnic unity;
7. Undermining state religious policy, or promoting cults and feudal superstitions;
8. Spreading rumors or false information, disrupting social order, or undermining social stability;
9. Disseminating obscenity, pornography, gambling, violence, homicide, terror, or incitement to crime, or trading in or manufacturing prohibited or controlled items;
10. Insulting or defaming others; infringing upon others' rights of reputation, portrait, privacy, intellectual property, or other lawful rights and interests; or impersonating or falsely assuming the name of state institutions, social organizations, or other legal persons;
11. Other activities prohibited by laws and regulations.

**3.3** To safeguard the lawful interests of Tencent and other users, unless permitted by law or with Tencent's written consent, you shall not engage in any of the following conduct:

1. Deleting copyright-related information on the Service or any copies thereof;
2. Reverse engineering, disassembling, or decompiling the Service, or otherwise attempting to discover the source code of the Service;
3. Using, leasing, lending, copying, modifying, linking to, republishing, compiling, publishing, or establishing mirror sites of content in which Tencent holds intellectual property rights;
4. Copying, modifying, adding to, deleting, hooking into the operation of, or creating derivative works from the Service or the data released into terminal memory during the operation of the Service, the interaction data between the client and server during the operation of the software, or the system data necessary for the operation of the Service, including through the use of plugins, cheats, or third-party tools or services not authorized by Tencent to access the Service and related systems;
5. Adding to, deleting, or altering the functions or operational effects of the software by modifying or forging instructions or data in the operation of the Service, or operating or disseminating to the public any software or methods used for the foregoing purposes, whether or not for commercial purposes;
6. Logging into or using Tencent software and services through third-party software, plugins, cheats, or systems not developed or authorized by Tencent, or creating, publishing, or disseminating such tools;
7. Interfering with the Service or its components, modules, or data, whether by yourself or by authorizing others or third-party software to do so;
8. Using the risk-assessment results or model capabilities of the Service without permission to develop security products or services that compete with Tencent;
9. Deleting, modifying, obscuring, or otherwise replacing any trade names, trademarks, service marks, domain names, or other conspicuous marks of Tencent or its partners that may be included in the provision of the Service;
10. Engaging in conduct that may affect or interfere with the normal operation of the Service or harm the lawful rights and interests of any other party;
11. Other conduct not expressly authorized by Tencent.

**3.4** You shall not use the Service to deliberately circumvent security checks, for example by obfuscating commands or bypassing plugin hooks so as to enable malicious commands to evade risk assessment.

**3.5** Please approach and use the Service scientifically, rationally, and in accordance with the law. **You understand and agree that the Service is only a supplementary security tool and cannot substitute for your own security awareness and judgment.** When using the Service, you must continue to exercise necessary attention and prudent judgment regarding the commands executed by the Agent.

---

## 4. Our Rights and Obligations

**4.1** We will maintain the normal operation of the Service to the extent permitted by current technical conditions, and will strive to enhance and improve our technology so that users' activities may proceed smoothly. We will provide safe, stable, and continuous services to users in accordance with the principle of good faith.

**4.2** We will actively take effective measures to fulfill all obligations prescribed by applicable laws and regulations. We are entitled to take action against your conduct that violates laws, regulations, or this Agreement, including measures such as issuing warnings, suspending the Service, restricting use, or terminating the Service, and to cooperate with the relevant authorities in handling such matters in accordance with the law.

**4.3** We will accept supervision from users and the public, and will submit to inspections by, and comply with the opinions of, the competent state authorities. If violations of laws, regulations, or this Agreement arise in the course of the operation of the Service, we will promptly take reasonable remedial measures such as suspending the Service or correcting the algorithmic model.

---

## 5. Intellectual Property and Other Rights

**5.1** Tencent is the rights holder of the programs, software, algorithms, models, and other intellectual-property-protected content on which the Service relies. The copyrights, trademark rights, patent rights, trade secrets, and other intellectual property rights in the Service are protected by the laws and regulations of the People's Republic of China and the applicable international treaties. Tencent lawfully enjoys the foregoing intellectual property rights, except for those rights that other rights holders are entitled to under the law. The copyright or trademark rights in the "Atuin Shell Guard" name and related commercial marks used by Tencent in the Service belong to Tencent.

**5.2** Without the written consent of Tencent or the relevant rights holder, you shall not exercise, exploit, or transfer the foregoing intellectual property rights, whether by yourself or by licensing any third party to do so.

---

## 6. User Personal Information

**6.1** Protecting user personal information is a fundamental principle of Tencent, and we will take measures to protect users' personal information. Except as provided by law, we will not disclose users' personal information to third parties without the user's permission. We store and transmit user personal information in encrypted form to safeguard its security. For details on how the Service collects, uses, stores, and protects your personal information, and the rights you enjoy, please read the *Atuin Shell Guard Plugin Privacy Policy*.

**6.2** In accordance with applicable laws and regulations, we will store user personal information collected within the territory of the People's Republic of China within the territory of the People's Republic of China. We will not provide your personal information outside such territory unless we have obtained your separate consent, or such provision is necessary for the performance of a contract concluded with you, or for compliance with obligations prescribed by laws and regulations.

---

## 7. Liability for Breach and Limitation of Liability

**7.1 You fully understand and agree that the Service, as a security-assistance plugin, provides only a pre-execution risk-assessment reference and does not constitute a final determination or guarantee of the safety of any command. Due to technical limitations, risk-assessment results may contain false positives or false negatives and should not serve as your sole basis for deciding whether to execute a command. You are responsible for your own use of the Service and the consequences arising therefrom; you must independently evaluate the risk warnings provided by the Service, continue to exercise necessary attention and prudent judgment regarding the commands executed by the Agent, and independently and prudently assess their accuracy and potential consequences.**

**7.2** You shall bear sole responsibility for any claims, demands, or losses asserted by third parties arising from or caused by your breach of this Agreement; if Tencent suffers losses as a result, you shall also compensate Tencent for such losses.

**7.3** If your conduct in violation of laws, regulations, or this Agreement causes losses to us, or if you interfere with the operation of the Service or with other users' use of the Service, we are entitled to seek compensation from you.

**7.4** The Service fulfills its basic assurance obligations in accordance with the law. **To the extent permitted by law, Tencent shall not be liable for interruptions to or effects on the Service caused by the following circumstances:**

1. Force majeure events such as natural disasters, strikes, riots, war, government actions, or judicial or administrative orders;
2. Maintenance of the hardware or software involved in the Service, or failures arising from various causes;
3. Public-service factors such as power-supply failures or telecommunications-network failures, or factors attributable to third parties.

**7.5** We are committed to providing a safe, stable, and continuous service. **You understand and agree that, notwithstanding our best efforts, due to the limitations of technological development, we cannot fully guarantee that:**

1. The Service or its algorithmic models will meet your actual or specific needs or purposes;
2. The Service or its algorithmic models will be one hundred percent accurate and reliable, functionally available, continuously stable, and free of faults;
3. The Service will completely and accurately identify and assess all types of high-risk commands;
4. The Service will cover all shell dialects, plugins, user-defined functions, or system-environment variations;
5. The Service will completely prevent all risks arising from dynamic scripts, obfuscated scripts, or external scripts.

**7.6** Unless otherwise stated on the relevant interfaces of the Service, otherwise agreed between you and us, or otherwise expressly provided by law, **we shall not be liable for damage caused to you by your use of the Service.**

**7.7 You understand and agree that you shall bear full responsibility for the subsequent execution at the operating-system level of any command permitted by the Service, and for all consequences thereof. Once a command has been permitted, its subsequent execution is carried out entirely by your device, operating system, and Agent platform, and Tencent assumes no liability whatsoever. You must independently exercise necessary attention, prudent judgment, and independent decision-making with respect to the commands executed by the Agent and the potential risks thereof.**

---

## 8. Third-Party Software, Products, or Services

**8.1** The Service may include third-party software, products, or services, and Tencent and such third parties shall each bear their respective liability within the scope prescribed by laws and regulations. When using third-party software, products, or services, you shall comply with the relevant requirements of such third parties; otherwise, such third parties or state authorities may bring proceedings against you, impose fines, or take other sanctions against you, and may request Tencent's assistance, in which case you shall bear the legal liability on your own.

**8.2** The AI Agent platforms to which the Service connects (such as Claude Code, Codex CLI, Hermes Agent, and OpenClaw) are operated by their respective service providers. **Your use of such Agent platforms and any subsequent operations are unrelated to us, and we are not responsible for the services of such Agent platforms.**

---

## 9. Complaints and Reports of Violations

**9.1** If you discover that the Service involves violations of laws or regulations, infringement of lawful rights and interests, breaches of public order and good morals, or similar circumstances, please promptly file a complaint or report through the channel below, and we will investigate and handle the matter in accordance with the law as soon as possible.

**9.2** Where required by laws and regulations, we will report issues discovered in the Service to the relevant authorities.

**9.3** You may file reports and complaints through the following channel:

Email for reports and complaints: **AtuinShellGuard@tencent.com**

Please describe the issue and provide relevant supporting materials in your email so that we may investigate and respond in a timely manner.

---

## 10. Changes to and Termination of the Service

**10.1** We will make necessary changes to the Service in light of the development of the Internet, business developments, and changes in laws and regulations, such as adjusting the content of the Service or suspending or terminating the Service. We will notify users by appropriate means.

**10.2** This Agreement shall automatically terminate or be dissolved upon the occurrence of any of the following: (1) we cease to provide the Service; (2) either we or you cease to exist or cease to possess civil legal capacity due to dissolution, bankruptcy, liquidation, or similar causes; or (3) you cease using the Service of your own accord.

---

## 11. Notice Regarding Use by Minors

**11.1** The Service is provided primarily to adults. If you are a minor under the age of 18, you may use the Service only after carefully reading and agreeing to this Agreement under the supervision and guidance of, and with the consent of, your guardian.

**11.2** We attach great importance to the protection of minors' personal information. Minor users should strengthen their awareness of personal protection when using the Service, and should use the Service properly with the consent of, and under the guidance of, their guardians.

**11.3** Minor users and their guardians understand and acknowledge that if a minor user violates laws or regulations, this Agreement, or the rules published on the relevant interfaces of the Service, the minor user and their guardian shall bear liability in accordance with the law.

---

## 12. Governing Law and Dispute Resolution

**12.1** The formation, performance, and interpretation of this Agreement, and the resolution of any disputes arising hereunder, shall be governed by the laws of China and subject to the jurisdiction of the courts of China.

**12.2 If a dispute arises between the parties concerning the content of this Agreement or its performance, the parties shall endeavor to resolve it through amicable negotiation. If negotiation fails, either party may bring a lawsuit before the competent court in the place where Tencent is located, namely Nanshan District, Shenzhen.**

---

## 13. Contact Information

If you have any comments or suggestions regarding this Agreement or matters relating to the Service, or if you have any questions or require assistance, please contact us as follows:

> **Operator:** Shenzhen Tencent Computer Systems Company Limited  
> **Address:** 35/F, Tencent Building, Kejizhongyi Road, Hi-Tech Park, Nanshan District, Shenzhen  
> **Email:** AtuinShellGuard@tencent.com

---

## 14. Miscellaneous

**14.1** This Agreement constitutes the entire agreement between the parties with respect to the matters agreed upon herein and other related matters. Except as provided in this Agreement, no other rights are conferred upon the parties hereto.

**14.2** If any provision of this Agreement is wholly or partially invalid or unenforceable for any reason whatsoever, the remaining provisions of this Agreement shall remain valid and binding.

**Shenzhen Tencent Computer Systems Company Limited**
