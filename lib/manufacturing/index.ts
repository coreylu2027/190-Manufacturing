import "server-only";
import { createSupabaseManufacturingAdapter } from "./supabase-adapter";
import { manufacturingSupabaseConfig } from "./config";
import { createSupabaseWriteAdapter } from "./write-adapter";

// Each call reads the server credentials, so a missing one fails that request rather than the import.
type Writer = ReturnType<typeof createSupabaseWriteAdapter>;
const reader = () => createSupabaseManufacturingAdapter(manufacturingSupabaseConfig());
const writer = () => createSupabaseWriteAdapter(manufacturingSupabaseConfig());

export const getManufacturingDataVersion = async () => reader().readDataVersion();
export const getManufacturingSnapshot = async () => reader().readSnapshot();
export const getQualityReviews: Writer["qualityReviews"] = async () => writer().qualityReviews();

export const setRequirementObsolete: Writer["setRequirementObsolete"] = async (...args) => writer().setRequirementObsolete(...args);
export const setRequirementHidden: Writer["setRequirementHidden"] = async (...args) => writer().setRequirementHidden(...args);
export const readEngineeringOverrideState: Writer["readEngineeringOverrideState"] = async (...args) => writer().readEngineeringOverrideState(...args);
export const readRequirementHistory: Writer["readRequirementHistory"] = async (...args) => writer().readRequirementHistory(...args);
export const readEngineeringCorrections: Writer["readEngineeringCorrections"] = async () => writer().readEngineeringCorrections();
export const listEngineeringSyncProposals: Writer["listEngineeringSyncProposals"] = async (...args) => writer().listEngineeringSyncProposals(...args);
export const readEngineeringSyncReviewState: Writer["readEngineeringSyncReviewState"] = async (...args) => writer().readEngineeringSyncReviewState(...args);
export const decideEngineeringSync: Writer["decideEngineeringSync"] = async (...args) => writer().decideEngineeringSync(...args);
export const applyEngineeringOverrides: Writer["applyEngineeringOverrides"] = async (...args) => writer().applyEngineeringOverrides(...args);
export const setAttachmentOverride: Writer["setAttachmentOverride"] = async (...args) => writer().setAttachmentOverride(...args);
export const applyQuantityAction: Writer["applyQuantityAction"] = async (...args) => writer().applyQuantityAction(...args);
export const applyQuantityActions: Writer["applyQuantityActions"] = async (...args) => writer().applyQuantityActions(...args);
export const stealOperationClaim: Writer["stealOperationClaim"] = async (...args) => writer().stealOperationClaim(...args);
export const patchOperation: Writer["patchOperation"] = async (...args) => writer().patchOperation(...args);
export const updateCamHandoff: Writer["updateCamHandoff"] = async (...args) => writer().updateCamHandoff(...args);
export const applyFabricationAction: Writer["applyFabricationAction"] = async (...args) => writer().applyFabricationAction(...args);
export const applyFabricationActions: Writer["applyFabricationActions"] = async (...args) => writer().applyFabricationActions(...args);
export const renameMachinistAllocations: Writer["renameMachinistAllocations"] = async (...args) => writer().renameMachinistAllocations(...args);
export const recordQualityReview: Writer["recordQualityReview"] = async (...args) => writer().recordQualityReview(...args);
export const updateRequirementNotes: Writer["updateRequirementNotes"] = async (...args) => writer().updateRequirementNotes(...args);
export const updatePassedQualityNotes: Writer["updatePassedQualityNotes"] = async (...args) => writer().updatePassedQualityNotes(...args);
export const updatePartLocation: Writer["updatePartLocation"] = async (...args) => writer().updatePartLocation(...args);
export const updatePartLocations: Writer["updatePartLocations"] = async (...args) => writer().updatePartLocations(...args);
export const passQualityReviews: Writer["passQualityReviews"] = async (...args) => writer().passQualityReviews(...args);
export const previewForceQuality: Writer["previewForceQuality"] = async (...args) => writer().previewForceQuality(...args);
export const forceQualityReview: Writer["forceQualityReview"] = async (...args) => writer().forceQualityReview(...args);
export const forceQualityReviews: Writer["forceQualityReviews"] = async (...args) => writer().forceQualityReviews(...args);
export const undoQualityReview: Writer["undoQualityReview"] = async (...args) => writer().undoQualityReview(...args);
