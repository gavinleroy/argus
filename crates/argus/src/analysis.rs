//! ProofTree analysis.

use rustc_data_structures::fx::FxIndexSet;
use rustc_hir::BodyId;
use rustc_hir::def_id::DefId;
use rustc_hir_analysis::astconv::AstConv;
use rustc_hir_typeck::{inspect_typeck, FnCtxt};
use rustc_infer::infer::error_reporting::TypeErrCtxt;
use rustc_infer::traits::FulfilledObligation;
use rustc_infer::traits::util::elaborate;
use rustc_middle::ty::{self, TyCtxt, ToPolyTraitRef};
use rustc_trait_selection::traits::FulfillmentError;
use rustc_trait_selection::traits::solve::Goal;

use anyhow::{Result, anyhow};
use fluid_let::fluid_let;
use rustc_utils::source_map::range::CharRange;
use serde::Serialize;

use crate::Target;
use crate::proof_tree::{SerializedTree, Obligation, ObligationKind};
use crate::proof_tree::ext::*;
use crate::proof_tree::serialize::serialize_proof_tree;

fluid_let!(pub static OBLIGATION_TARGET: Target);

pub fn obligations<'tcx>(tcx: TyCtxt<'tcx>, body_id: BodyId) -> Result<serde_json::Value>
{
  let hir = tcx.hir();
  let local_def_id = hir.body_owner_def_id(body_id);
  let def_id = local_def_id.to_def_id();

  log::info!("Getting obligations in body {}", {
    let owner = hir.body_owner(body_id);
    hir.opt_name(owner).map(|s| s.to_string()).unwrap_or("<anon>".to_string())
  });

  let mut result = Err(anyhow!("Hir Typeck never called inspect fn."));

  inspect_typeck(tcx, local_def_id, |fncx| {
    let Some(infcx) = fncx.infcx() else {
      return;
    };

    let mut errors = fncx.get_fulfillment_errors();
    fncx.adjust_fulfillment_errors_for_expr_obligation(&mut errors);
    let obligations = fncx.report_fulfillment_errors(def_id, errors);
    let json = crate::ty::in_dynamic_ctx(infcx, || {
      serde_json::to_value(&obligations).expect("Could not serialize Obligations")
    });
    result = Ok(json);
  });

  result
}


pub fn tree<'tcx>(tcx: TyCtxt<'tcx>, body_id: BodyId) -> Result<Option<SerializedTree>>
{
  OBLIGATION_TARGET.get(|target| {
    let target = target.unwrap();

    let hir = tcx.hir();
    let local_def_id = hir.body_owner_def_id(body_id);
    let def_id = local_def_id.to_def_id();

    log::info!("Getting obligations");

    let mut result = None;

    inspect_typeck(tcx, local_def_id, |fncx| {
      let Some(infcx) = fncx.infcx() else {
        return;
      };

      let errors = fncx.get_fulfillment_errors();

      result = errors.iter().find_map(|error| {
        let (pretty, goal) = (
          error.root_obligation.predicate.pretty(infcx, def_id),
          Goal { predicate: error.root_obligation.predicate, param_env: error.root_obligation.param_env }
        );

        if &pretty != &target.data {
          return None;
        }

        serialize_tree(goal, fncx)
      })
    });

    Ok(result)

  })
}

// fn serialize_error_tree<'tcx>(error: &FulfillmentError<'tcx>, fcx: &FnCtxt<'_, 'tcx>) -> Option<SerializedTree> {
//   let o = &error.root_obligation;
//   let goal = Goal { predicate: o.predicate, param_env: o.param_env };
//   serialize_tree(goal, fcx)
// }

fn serialize_tree<'tcx>(goal: Goal<'tcx, ty::Predicate<'tcx>>, fcx: &FnCtxt<'_, 'tcx>) -> Option<SerializedTree> {
  let def_id = fcx.item_def_id();
  let infcx = fcx.infcx().expect("`FnCtxt` missing a `InferCtxt`.");

  serialize_proof_tree(goal, infcx, def_id)
}

// --------------------------------

trait FnCtxtExt<'tcx> {
  fn get_fulfillment_errors(&self) -> Vec<FulfillmentError<'tcx>>;
  fn adjust_fulfillment_errors_for_expr_obligation(&self, errors: &mut Vec<FulfillmentError<'tcx>>);
  fn report_fulfillment_errors(&self, def_id: DefId, errors: Vec<FulfillmentError<'tcx>>) -> Vec<Obligation<'tcx>>;
}

trait InferPrivateExt<'tcx> {
  fn error_implies(&self, cond: ty::Predicate<'tcx>, error: ty::Predicate<'tcx>) -> bool;
}

// Taken from rustc_trait_selection/src/traits/error_reporting/type_err_ctxt_ext.rs
impl<'tcx> InferPrivateExt<'tcx> for TypeErrCtxt<'_, 'tcx> {
  fn error_implies(&self, cond: ty::Predicate<'tcx>, error: ty::Predicate<'tcx>) -> bool {
    use log::debug;

    if cond == error {
      return true;
    }

    // FIXME: It should be possible to deal with `ForAll` in a cleaner way.
    let bound_error = error.kind();
    let (cond, error) = match (cond.kind().skip_binder(), bound_error.skip_binder()) {
      (
        ty::PredicateKind::Clause(ty::ClauseKind::Trait(..)),
        ty::PredicateKind::Clause(ty::ClauseKind::Trait(error)),
      ) => (cond, bound_error.rebind(error)),
      _ => {
        // FIXME: make this work in other cases too.
        return false;
      }
    };

    for pred in elaborate(self.tcx, std::iter::once(cond)) {
      let bound_predicate = pred.kind();
      if let ty::PredicateKind::Clause(ty::ClauseKind::Trait(implication)) =
        bound_predicate.skip_binder()
      {
        let error = error.to_poly_trait_ref();
        let implication = bound_predicate.rebind(implication.trait_ref);
        // FIXME: I'm just not taking associated types at all here.
        // Eventually I'll need to implement param-env-aware
        // `Γ₁ ⊦ φ₁ => Γ₂ ⊦ φ₂` logic.
        let param_env = ty::ParamEnv::empty();
        if self.can_sub(param_env, error, implication) {
          debug!("error_implies: {:?} -> {:?} -> {:?}", cond, error, implication);
          return true;
        }
      }
    }

    false
  }
}

impl<'tcx> FnCtxtExt<'tcx> for FnCtxt<'_, 'tcx> {
  fn get_fulfillment_errors(&self) -> Vec<FulfillmentError<'tcx>> {
    let errors = self.fulfillment_errors.borrow();

    let result = errors.iter().map(Clone::clone).collect::<Vec<_>>();

    if !result.is_empty() {
      return result;
    }

    let mut result = Vec::new();

    if let Some(infcx) = self.infcx() {
      let fulfilled_obligations = infcx.fulfilled_obligations.borrow();
      let tcx = &infcx.tcx;

      result.extend(
        fulfilled_obligations.iter().filter_map(|obl| {
          match obl {
            FulfilledObligation::Failure {
              error,
              ..
            } if error.root_obligation.predicate.is_necessary(tcx) => Some(error.clone()),
            _ => None,
          }
        }));
    }

    result
  }

  // Implementation taken from rustc_hir_typeck/fn_ctxt/checks.rs :: adjust_fulfillment_errors_for_expr_obligation
  fn adjust_fulfillment_errors_for_expr_obligation(&self, errors: &mut Vec<FulfillmentError<'tcx>>) {

    let mut remap_cause = FxIndexSet::default();
    let mut not_adjusted = vec![];

    for error in errors {
      let before_span = error.obligation.cause.span;
      if self.adjust_fulfillment_error_for_expr_obligation(error)
        || before_span != error.obligation.cause.span
      {
        remap_cause.insert((
          before_span,
          error.obligation.predicate,
          error.obligation.cause.clone(),
        ));
      } else {
        not_adjusted.push(error);
      }
    }

    for error in not_adjusted {
      for (span, predicate, cause) in &remap_cause {
        if *predicate == error.obligation.predicate
          && span.contains(error.obligation.cause.span)
        {
          error.obligation.cause = cause.clone();
          continue;
        }
      }
    }
  }

  fn report_fulfillment_errors(&self, def_id: DefId, mut errors: Vec<FulfillmentError<'tcx>>) -> Vec<Obligation<'tcx>> {
    if errors.is_empty() {
      return Vec::new();
    }
    let source_map = self.tcx().sess.source_map();
    let infcx = self.infcx().unwrap();
    // let this = self.err_ctxt();

    // let reported = this
    //   .reported_trait_errors
    //   .borrow()
    //   .iter()
    //   .flat_map(|(_, ps)| {
    //     ps.iter().copied()
    //   })
    //   .collect::<Vec<_>>();

    // // FIXME
    // let _split_idx = itertools::partition(&mut errors, |error| {
    //   reported.iter().any(|p| *p == error.obligation.predicate)
    // });

    // let reported_errors = this.reported_trait_errors.borrow();

    // log::debug!("Reported_errors {_split_idx} {reported_errors:#?}");

    errors.into_iter().map(|error| {
      let range = CharRange::from_span(error.obligation.cause.span, source_map).unwrap();

      Obligation {
        data: error.root_obligation.predicate, // pretty(infcx, def_id),
        range,
        kind: ObligationKind::Failure
      }
    }).collect::<Vec<_>>()
  }
}
