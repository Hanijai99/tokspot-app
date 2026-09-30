/**
 * TokSpot medicine catalog — bundled, searchable, extendable.
 *
 * Used by the doctor desk prescription writer (prototype mode). Each entry:
 *   { name, category, strengths: [] }   — strengths are the common
 *   pack sizes for quick selection; doctors can also free-type anything.
 *
 * To add medicines: append entries here (names must be unique). The
 * prescription writer also lets a doctor add a brand-new medicine name
 * directly at the desk, so the catalog never blocks a valid prescription.
 */
(function (root) {
  const TOKSPOT_MEDICINES = [
    // ---- Analgesics / Antipyretics ----
    { name: 'Paracetamol', category: 'Analgesic / Antipyretic', strengths: ['250mg', '500mg', '650mg', '1g'] },
    { name: 'Ibuprofen', category: 'Analgesic / NSAID', strengths: ['200mg', '400mg', '600mg'] },
    { name: 'Diclofenac', category: 'Analgesic / NSAID', strengths: ['50mg', '75mg', '100mg SR', 'Gel 1%'] },
    { name: 'Aceclofenac', category: 'Analgesic / NSAID', strengths: ['100mg'] },
    { name: 'Aspirin', category: 'Analgesic / Antiplatelet', strengths: ['75mg', '150mg', '325mg'] },
    { name: 'Nimesulide', category: 'Analgesic / NSAID', strengths: ['100mg'] },
    { name: 'Mefenamic Acid', category: 'Analgesic / NSAID', strengths: ['250mg', '500mg'] },
    { name: 'Naproxen', category: 'Analgesic / NSAID', strengths: ['250mg', '500mg'] },
    { name: 'Tramadol', category: 'Opioid Analgesic', strengths: ['50mg', '100mg SR'] },
    { name: 'Paracetamol + Caffeine', category: 'Analgesic Combination', strengths: ['500mg + 65mg'] },

    // ---- Antibiotics ----
    { name: 'Amoxicillin', category: 'Antibiotic (Penicillin)', strengths: ['250mg', '500mg', '875mg'] },
    { name: 'Amoxicillin + Clavulanate', category: 'Antibiotic (Penicillin)', strengths: ['625mg', '1g', '228.5mg'] },
    { name: 'Azithromycin', category: 'Antibiotic (Macrolide)', strengths: ['250mg', '500mg'] },
    { name: 'Ciprofloxacin', category: 'Antibiotic (Fluoroquinolone)', strengths: ['250mg', '500mg', '750mg'] },
    { name: 'Levofloxacin', category: 'Antibiotic (Fluoroquinolone)', strengths: ['500mg', '750mg'] },
    { name: 'Ofloxacin', category: 'Antibiotic (Fluoroquinolone)', strengths: ['200mg', '400mg'] },
    { name: 'Norfloxacin', category: 'Antibiotic (Fluoroquinolone)', strengths: ['400mg'] },
    { name: 'Doxycycline', category: 'Antibiotic (Tetracycline)', strengths: ['100mg'] },
    { name: 'Cephalexin', category: 'Antibiotic (Cephalosporin)', strengths: ['250mg', '500mg'] },
    { name: 'Cefixime', category: 'Antibiotic (Cephalosporin)', strengths: ['200mg', '400mg'] },
    { name: 'Cefpodoxime', category: 'Antibiotic (Cephalosporin)', strengths: ['100mg', '200mg'] },
    { name: 'Cefuroxime', category: 'Antibiotic (Cephalosporin)', strengths: ['250mg', '500mg'] },
    { name: 'Cloxacillin', category: 'Antibiotic (Penicillin)', strengths: ['250mg', '500mg'] },
    { name: 'Metronidazole', category: 'Antibiotic / Antiprotozoal', strengths: ['200mg', '400mg', '500mg'] },
    { name: 'Ornidazole', category: 'Antibiotic / Antiprotozoal', strengths: ['500mg'] },
    { name: 'Tinidazole', category: 'Antibiotic / Antiprotozoal', strengths: ['300mg', '500mg'] },
    { name: 'Nitrofurantoin', category: 'Antibiotic (UTI)', strengths: ['50mg', '100mg'] },
    { name: 'Cotrimoxazole', category: 'Antibiotic (Sulfonamide)', strengths: ['480mg', '960mg'] },
    { name: 'Linezolid', category: 'Antibiotic (Oxazolidinone)', strengths: ['600mg'] },
    { name: 'Clarithromycin', category: 'Antibiotic (Macrolide)', strengths: ['250mg', '500mg'] },
    { name: 'Erythromycin', category: 'Antibiotic (Macrolide)', strengths: ['250mg', '500mg'] },
    { name: 'Roxithromycin', category: 'Antibiotic (Macrolide)', strengths: ['150mg', '300mg'] },
    { name: 'Clindamycin', category: 'Antibiotic (Lincosamide)', strengths: ['150mg', '300mg', 'Capsule'] },

    // ---- Acid / Stomach / Gut ----
    { name: 'Pantoprazole', category: 'Antacid / PPI', strengths: ['20mg', '40mg'] },
    { name: 'Omeprazole', category: 'Antacid / PPI', strengths: ['20mg', '40mg'] },
    { name: 'Esomeprazole', category: 'Antacid / PPI', strengths: ['20mg', '40mg'] },
    { name: 'Rabeprazole', category: 'Antacid / PPI', strengths: ['20mg'] },
    { name: 'Ranitidine', category: 'Antacid / H2 Blocker', strengths: ['150mg', '300mg'] },
    { name: 'Famotidine', category: 'Antacid / H2 Blocker', strengths: ['20mg', '40mg'] },
    { name: 'Antacid Suspension', category: 'Antacid Combination', strengths: ['10ml', '15ml'] },
    { name: 'Domperidone', category: 'Anti-emetic / Prokinetic', strengths: ['10mg', '30mg SR'] },
    { name: 'Ondansetron', category: 'Anti-emetic', strengths: ['4mg', '8mg'] },
    { name: 'Metoclopramide', category: 'Anti-emetic / Prokinetic', strengths: ['5mg', '10mg'] },
    { name: 'Loperamide', category: 'Antidiarrheal', strengths: ['2mg'] },
    { name: 'ORS Powder', category: 'Rehydration', strengths: ['21g sachet'] },
    { name: 'Lactulose', category: 'Laxative', strengths: ['10ml', '15ml'] },
    { name: 'Bisacodyl', category: 'Laxative', strengths: ['5mg'] },
    { name: 'Isabgol (Psyllium)', category: 'Laxative / Fiber', strengths: ['3.5g sachet'] },
    { name: 'Dicyclomine', category: 'Antispasmodic', strengths: ['10mg', '20mg'] },
    { name: 'Hyoscine (Buscopan)', category: 'Antispasmodic', strengths: ['10mg'] },
    { name: 'Sucralfate', category: 'Antacid / Ulcer', strengths: ['1g'] },
    { name: 'Probiotic Capsule', category: 'Gut Health', strengths: ['Billion CFU'] },

    // ---- Diabetes ----
    { name: 'Metformin', category: 'Diabetes (Biguanide)', strengths: ['500mg', '850mg', '1g SR'] },
    { name: 'Glimepiride', category: 'Diabetes (Sulfonylurea)', strengths: ['1mg', '2mg', '3mg'] },
    { name: 'Gliclazide', category: 'Diabetes (Sulfonylurea)', strengths: ['30mg MR', '60mg MR', '80mg'] },
    { name: 'Glibenclamide', category: 'Diabetes (Sulfonylurea)', strengths: ['5mg'] },
    { name: 'Pioglitazone', category: 'Diabetes (TZD)', strengths: ['15mg', '30mg'] },
    { name: 'Sitagliptin', category: 'Diabetes (DPP-4)', strengths: ['50mg', '100mg'] },
    { name: 'Vildagliptin', category: 'Diabetes (DPP-4)', strengths: ['50mg'] },
    { name: 'Dapagliflozin', category: 'Diabetes (SGLT2)', strengths: ['5mg', '10mg'] },
    { name: 'Empagliflozin', category: 'Diabetes (SGLT2)', strengths: ['10mg', '25mg'] },
    { name: 'Insulin Glargine', category: 'Diabetes (Insulin)', strengths: ['100 IU/ml'] },
    { name: 'Insulin (Mixtard)', category: 'Diabetes (Insulin)', strengths: ['30/70'] },
    { name: 'Vitamin D3 + Calcium', category: 'Diabetes Support / Bone', strengths: ['60K IU + 500mg'] },

    // ---- BP / Heart ----
    { name: 'Amlodipine', category: 'BP / Heart (CCB)', strengths: ['2.5mg', '5mg', '10mg'] },
    { name: 'Telmisartan', category: 'BP (ARB)', strengths: ['20mg', '40mg', '80mg'] },
    { name: 'Losartan', category: 'BP (ARB)', strengths: ['25mg', '50mg', '100mg'] },
    { name: 'Valsartan', category: 'BP (ARB)', strengths: ['40mg', '80mg', '160mg'] },
    { name: 'Ramipril', category: 'BP (ACE Inhibitor)', strengths: ['2.5mg', '5mg', '10mg'] },
    { name: 'Enalapril', category: 'BP (ACE Inhibitor)', strengths: ['2.5mg', '5mg', '10mg'] },
    { name: 'Metoprolol', category: 'BP / Heart (Beta Blocker)', strengths: ['25mg', '50mg', '100mg'] },
    { name: 'Atenolol', category: 'BP / Heart (Beta Blocker)', strengths: ['25mg', '50mg'] },
    { name: 'Carvedilol', category: 'BP / Heart (Beta Blocker)', strengths: ['3.125mg', '6.25mg', '12.5mg'] },
    { name: 'Nifedipine', category: 'BP / Heart (CCB)', strengths: ['10mg', '20mg SR'] },
    { name: 'Furosemide', category: 'Diuretic', strengths: ['20mg', '40mg'] },
    { name: 'Spironolactone', category: 'Diuretic (K-sparing)', strengths: ['25mg', '50mg', '100mg'] },
    { name: 'Hydrochlorothiazide', category: 'Diuretic', strengths: ['12.5mg', '25mg'] },
    { name: 'Digoxin', category: 'BP / Heart', strengths: ['0.25mg'] },
    { name: 'Nitroglycerin', category: 'BP / Heart (Angina)', strengths: ['2.6mg SR', 'Sublingual'] },
    { name: 'Isosorbide Mononitrate', category: 'BP / Heart (Angina)', strengths: ['20mg', '30mg SR'] },
    { name: 'Clopidogrel', category: 'Antiplatelet', strengths: ['75mg'] },
    { name: 'Ticagrelor', category: 'Antiplatelet', strengths: ['90mg'] },

    // ---- Cholesterol ----
    { name: 'Atorvastatin', category: 'Cholesterol (Statin)', strengths: ['10mg', '20mg', '40mg'] },
    { name: 'Rosuvastatin', category: 'Cholesterol (Statin)', strengths: ['5mg', '10mg', '20mg'] },
    { name: 'Simvastatin', category: 'Cholesterol (Statin)', strengths: ['10mg', '20mg', '40mg'] },
    { name: 'Fenofibrate', category: 'Cholesterol (Fibrate)', strengths: ['145mg', '160mg'] },
    { name: 'Ezetimibe', category: 'Cholesterol (Absorption)', strengths: ['10mg'] },

    // ---- Asthma / Allergy / Respiratory ----
    { name: 'Salbutamol', category: 'Asthma / Respiratory', strengths: ['100mcg Inhaler', '2mg', '4mg'] },
    { name: 'Levosalbutamol', category: 'Asthma / Respiratory', strengths: ['50mcg Inhaler'] },
    { name: 'Budesonide', category: 'Asthma / Steroid', strengths: ['200mcg Inhaler', '400mcg Rotacap'] },
    { name: 'Formoterol + Budesonide', category: 'Asthma Combination', strengths: ['160mcg + 4.5mcg'] },
    { name: 'Ipratropium', category: 'Asthma / Respiratory', strengths: ['20mcg Inhaler'] },
    { name: 'Montelukast', category: 'Allergy / Asthma', strengths: ['5mg', '10mg'] },
    { name: 'Levocetirizine', category: 'Antihistamine', strengths: ['5mg'] },
    { name: 'Cetirizine', category: 'Antihistamine', strengths: ['10mg'] },
    { name: 'Fexofenadine', category: 'Antihistamine', strengths: ['120mg', '180mg'] },
    { name: 'Loratadine', category: 'Antihistamine', strengths: ['10mg'] },
    { name: 'Chlorpheniramine', category: 'Antihistamine', strengths: ['4mg', '2mg/5ml Syrup'] },
    { name: 'Dextromethorphan', category: 'Cough Suppressant', strengths: ['10mg', '15mg/5ml Syrup'] },
    { name: 'Ambroxol', category: 'Mucolytic', strengths: ['30mg', '15mg/5ml Syrup'] },
    { name: 'Acetylcysteine', category: 'Mucolytic', strengths: ['600mg', '100mg Sachet'] },
    { name: 'Guaifenesin', category: 'Expectorant', strengths: ['100mg/5ml'] },
    { name: 'Theophylline', category: 'Asthma / Respiratory', strengths: ['200mg SR'] },

    // ---- Vitamins / Supplements ----
    { name: 'Vitamin B Complex', category: 'Vitamins', strengths: ['Capsule'] },
    { name: 'Vitamin C', category: 'Vitamins', strengths: ['500mg', '1000mg'] },
    { name: 'Vitamin D3', category: 'Vitamins', strengths: ['400 IU', '1000 IU', '60K IU'] },
    { name: 'Calcium + Vitamin D3', category: 'Bone Health', strengths: ['500mg + 250 IU'] },
    { name: 'Iron + Folic Acid', category: 'Vitamins / Anaemia', strengths: ['100mg + 0.5mg'] },
    { name: 'Zinc', category: 'Vitamins', strengths: ['20mg', '50mg'] },
    { name: 'Multivitamin', category: 'Vitamins', strengths: ['Capsule'] },
    { name: 'Omega-3 Fish Oil', category: 'Supplements', strengths: ['1000mg'] },
    { name: 'Folic Acid', category: 'Vitamins', strengths: ['5mg'] },
    { name: 'Vitamin B12', category: 'Vitamins', strengths: ['1500mcg'] },

    // ---- Thyroid / Hormones ----
    { name: 'Levothyroxine', category: 'Thyroid', strengths: ['25mcg', '50mcg', '75mcg', '100mcg'] },
    { name: 'Prednisolone', category: 'Steroid', strengths: ['5mg', '10mg', '20mg'] },
    { name: 'Dexamethasone', category: 'Steroid', strengths: ['0.5mg', '4mg'] },
    { name: 'Hydrocortisone', category: 'Steroid', strengths: ['Tablet 10mg', 'Cream 1%'] },
    { name: 'Betamethasone', category: 'Steroid', strengths: ['Cream 0.05%'] },
    { name: 'Methylprednisolone', category: 'Steroid', strengths: ['4mg', '16mg'] },

    // ---- Skin ----
    { name: 'Clotrimazole', category: 'Skin (Antifungal)', strengths: ['Cream 1%', 'Powder'] },
    { name: 'Miconazole', category: 'Skin (Antifungal)', strengths: ['Cream 2%'] },
    { name: 'Ketoconazole', category: 'Skin (Antifungal)', strengths: ['Shampoo 2%', 'Cream 2%'] },
    { name: 'Terbinafine', category: 'Skin (Antifungal)', strengths: ['250mg', 'Cream 1%'] },
    { name: 'Fluconazole', category: 'Antifungal (Systemic)', strengths: ['150mg', '200mg'] },
    { name: 'Acyclovir', category: 'Antiviral (Herpes)', strengths: ['200mg', '400mg', '800mg', 'Cream 5%'] },
    { name: 'Fusidic Acid', category: 'Skin (Antibiotic)', strengths: ['Cream 2%', 'Ointment 2%'] },
    { name: 'Mupirocin', category: 'Skin (Antibiotic)', strengths: ['Ointment 2%'] },
    { name: 'Calamine Lotion', category: 'Skin (Soothing)', strengths: ['Lotion 8%'] },
    { name: 'Permethrin', category: 'Skin (Scabies/Lice)', strengths: ['Cream 5%', 'Lotion 1%'] },
    { name: 'Isotretinoin', category: 'Skin (Acne)', strengths: ['10mg', '20mg'] },

    // ---- Eye / ENT ----
    { name: 'Ciprofloxacin Eye Drops', category: 'Eye', strengths: ['0.3%'] },
    { name: 'Tobramycin Eye Drops', category: 'Eye', strengths: ['0.3%'] },
    { name: 'Moxifloxacin Eye Drops', category: 'Eye', strengths: ['0.5%'] },
    { name: 'Artificial Tears', category: 'Eye', strengths: ['0.1% Hyaluronic Acid'] },
    { name: 'Ofloxacin Eye Drops', category: 'Eye', strengths: ['0.3%'] },
    { name: 'Xylometazoline Nasal Drops', category: 'ENT (Decongestant)', strengths: ['0.1%', '0.05%'] },
    { name: 'Fluticasone Nasal Spray', category: 'ENT (Steroid)', strengths: ['50mcg'] },
    { name: 'Amoxicillin (ENT Dose)', category: 'ENT', strengths: ['250mg Susp'] },

    // ---- Neuro / Mental Health ----
    { name: 'Diazepam', category: 'Neuro / Sedative', strengths: ['5mg', '10mg'] },
    { name: 'Alprazolam', category: 'Neuro / Anxiety', strengths: ['0.25mg', '0.5mg'] },
    { name: 'Clonazepam', category: 'Neuro / Anxiety', strengths: ['0.25mg', '0.5mg', '1mg'] },
    { name: 'Sertraline', category: 'Mental Health (SSRI)', strengths: ['25mg', '50mg', '100mg'] },
    { name: 'Escitalopram', category: 'Mental Health (SSRI)', strengths: ['5mg', '10mg', '20mg'] },
    { name: 'Fluoxetine', category: 'Mental Health (SSRI)', strengths: ['20mg', '40mg'] },
    { name: 'Amitriptyline', category: 'Mental Health (TCA)', strengths: ['10mg', '25mg', '50mg'] },
    { name: 'Carbamazepine', category: 'Neuro (Anti-epileptic)', strengths: ['200mg', '400mg SR'] },
    { name: 'Phenytoin', category: 'Neuro (Anti-epileptic)', strengths: ['100mg'] },
    { name: 'Valproate', category: 'Neuro (Anti-epileptic)', strengths: ['200mg', '500mg'] },
    { name: 'Levetiracetam', category: 'Neuro (Anti-epileptic)', strengths: ['250mg', '500mg', '750mg'] },
    { name: 'Sumatriptan', category: 'Neuro (Migraine)', strengths: ['50mg'] },

    // ---- Urology / Men's Health ----
    { name: 'Tamsulosin', category: 'Urology (BPH)', strengths: ['0.4mg'] },
    { name: 'Finasteride', category: 'Urology / Hair', strengths: ['1mg', '5mg'] },
    { name: 'Sildenafil', category: 'Men\'s Health', strengths: ['25mg', '50mg', '100mg'] },
    { name: 'Tadalafil', category: 'Men\'s Health', strengths: ['5mg', '10mg', '20mg'] },

    // ---- Anticoagulants / Other ----
    { name: 'Warfarin', category: 'Anticoagulant', strengths: ['1mg', '2mg', '5mg'] },
    { name: 'Rivaroxaban', category: 'Anticoagulant', strengths: ['10mg', '15mg', '20mg'] },
    { name: 'Apixaban', category: 'Anticoagulant', strengths: ['2.5mg', '5mg'] },
    { name: 'Cinnarizine', category: 'Vertigo', strengths: ['25mg'] },
    { name: 'Hydroxychloroquine', category: 'Antimalarial / Immunomodulator', strengths: ['200mg'] },
    { name: 'Albendazole', category: 'Anthelmintic', strengths: ['400mg'] },
    { name: 'Mebendazole', category: 'Anthelmintic', strengths: ['100mg'] },
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = TOKSPOT_MEDICINES;
  if (root) root.TOKSPOT_MEDICINES = root.TOKSPOT_MEDICINES || TOKSPOT_MEDICINES;
})(typeof globalThis !== 'undefined' ? globalThis : this);